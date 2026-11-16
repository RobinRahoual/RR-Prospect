import { describe, expect, it } from "vitest";
import { buildOverpassQuery, Database, DEFAULT_SCAN, elementToLead, executeTool, geocode, normalizeScan, Repo, scanArea } from "../index";

async function mkRepo() {
  const repo = new Repo(await Database.open());
  repo.migrate();
  return repo;
}
const json = (v: unknown, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => v });

describe("réglages de scan", () => {
  it("borne le rayon et le maximum, refuse l'invalide", () => {
    expect(normalizeScan({ radiusKm: 999, maxResults: 0 }).radiusKm).toBe(50);
    expect(normalizeScan({ maxResults: 9999 }).maxResults).toBe(500);
    expect(normalizeScan({ categories: ["bars", "nope", "bars"] }).categories).toEqual(["bars"]);
    expect(() => normalizeScan({ categories: ["nope"] })).toThrow(/catégorie/);
    expect(() => normalizeScan({ lat: 200 })).toThrow(/Coordonnées/);
  });
  it("construit la requête Overpass depuis les réglages", () => {
    const q = buildOverpassQuery({ ...DEFAULT_SCAN, radiusKm: 5, categories: ["bars", "clubs"] });
    expect(q).toContain("around:5000,47.322,5.0415");
    expect(q).toContain('"amenity"~"^(bar|pub)$"');
    expect(q).toContain("nightclub");
    expect(q).not.toContain("restaurant");
  });
});

describe("OSM", () => {
  it("score : pas de site > page Facebook > site réel", () => {
    const none = elementToLead({ type: "node", id: 1, tags: { name: "A" } }, "Bars", "Dijon")!;
    const fb = elementToLead({ type: "node", id: 2, tags: { name: "B", website: "facebook.com/b" } }, "Bars", null)!;
    const ok = elementToLead({ type: "node", id: 3, tags: { name: "C", website: "https://c.fr", "contact:instagram": "c" } }, "Bars", null)!;
    expect(none.gapScore).toBe(50);
    expect(fb.gapScore).toBe(30);
    expect(fb.website).toBe("https://facebook.com/b");
    expect(ok.gapScore).toBe(0);
    expect(elementToLead({ type: "node", id: 4 }, "x", null)).toBeNull();
  });
  it("scan : ajoute, trie, respecte le maximum, dédoublonne, bascule de miroir", async () => {
    const repo = await mkRepo();
    const els = [
      { type: "node", id: 1, tags: { name: "Bar Riche", website: "https://x.fr", "contact:instagram": "x", amenity: "bar" } },
      { type: "node", id: 2, tags: { name: "Bar Pauvre", amenity: "bar" } },
      { type: "way", id: 3, tags: { name: "Club Pauvre", amenity: "nightclub" } },
    ];
    let n = 0;
    const f = (async () => (n++ === 0 ? json({}, false) : json({ elements: els }))) as any;
    const r = await scanArea(repo, { ...DEFAULT_SCAN, maxResults: 2 }, f);
    expect(n).toBe(2); // premier miroir en erreur, second OK
    expect(r).toMatchObject({ found: 3, added: 2 });
    expect(repo.listLeads().map((l) => l.name).sort()).toEqual(["Bar Pauvre", "Club Pauvre"]);
    const again = await scanArea(repo, { ...DEFAULT_SCAN, maxResults: 5 }, (async () => json({ elements: els })) as any);
    expect(again).toMatchObject({ added: 1, duplicates: 2 });
  });
  it("scan : erreur claire si tous les miroirs échouent", async () => {
    const repo = await mkRepo();
    await expect(scanArea(repo, DEFAULT_SCAN, (async () => json({}, false)) as any)).rejects.toThrow(/indisponible/);
  });
  it("geocode", async () => {
    const g = await geocode("Dijon", (async () => json([{ lat: "47.32", lon: "5.04", display_name: "Dijon, Côte-d'Or, France" }])) as any);
    expect(g).toEqual({ label: "Dijon, Côte-d'Or", lat: 47.32, lon: 5.04 });
    await expect(geocode("zzz", (async () => json([])) as any)).rejects.toThrow(/introuvable/);
  });
});

describe("outil scan_area", () => {
  it("passe les surcharges et renvoie le résumé", async () => {
    const repo = await mkRepo();
    let got: any;
    const deps = {
      repo,
      generateDraft: async () => ({ draft: { subject: "", bodyHtml: "", hookUsed: "", confidence: 0 }, engine: "t" }),
      scan: async (o: any) => {
        got = o;
        repo.createLead({ name: "Nouveau", gapScore: 50 });
        return { found: 1, added: 1, duplicates: 0, source: "OpenStreetMap", settings: DEFAULT_SCAN };
      },
    };
    const out = await executeTool(deps, { id: "1", name: "scan_area", args: { categories: ["bars"], radius_km: 5 } });
    expect(got).toEqual({ categories: ["bars"], radiusKm: 5 });
    expect((out.result as any).ajoutés).toBe(1);
    expect(out.cards).toHaveLength(1);
  });
});
