import { describe, expect, it } from "vitest";
import {
  analyzeLead, Database, DEFAULT_SCAN, eventToLead, executeTool, extractSignals, isPublicHost, itemToLead, normalizeScan, pickEmail,
  Repo, runScan, scanOpenAgenda, scanSirene, scoreSite,
} from "../index";

async function mkRepo() {
  const repo = new Repo(await Database.open());
  repo.migrate();
  return repo;
}
const ok = (v: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => v, text: async () => String(v) });
const NOW = new Date("2026-11-16");

describe("SIRENE", () => {
  it("garde les entreprises récentes et actives, score selon l'âge", () => {
    const base = { nom_complet: "LE NOUVEAU BAR", siren: "1", etat_administratif: "A", siege: { siret: "10", date_creation: "2026-06-01", libelle_commune: "DIJON", adresse: "1 rue X" } };
    const l = itemToLead(base, "Bars", 18, NOW)!;
    expect(l.placeId).toBe("siret:10");
    expect(l.gapScore).toBe(50); // 5 mois
    expect(itemToLead({ ...base, siege: { ...base.siege, date_creation: "2020-01-01" } }, "Bars", 18, NOW)).toBeNull();
    expect(itemToLead({ ...base, etat_administratif: "C" }, "Bars", 18, NOW)).toBeNull();
  });
  it("scan : pagine, dédoublonne par nom avec les leads existants", async () => {
    const repo = await mkRepo();
    repo.createLead({ name: "Le Nouveau Bar", source: "osm" });
    const item = (n: string, siret: string) => ({ nom_complet: n, etat_administratif: "A", siege: { siret, date_creation: "2026-08-01" } });
    const f = (async () => ok({ results: [item("LE NOUVEAU BAR", "1"), item("CHEZ ZAZA", "2")] })) as any;
    const r = await scanSirene(repo, { ...DEFAULT_SCAN, categories: ["clubs"] }, f, undefined, NOW);
    expect(r).toMatchObject({ added: 1, duplicates: 1 });
    expect(repo.listLeads().map((l) => l.name)).toContain("CHEZ ZAZA");
  });
});

describe("OpenAgenda", () => {
  it("convertit un événement (titre multilingue) en lead", () => {
    const l = eventToLead({ uid: 42, title: { fr: "Concert" }, firstTiming: { begin: "2026-12-01T20:00" }, canonicalUrl: "https://oa/x", location: { name: "La Vapeur", city: "Dijon" } })!;
    expect(l).toMatchObject({ kind: "event", name: "La Vapeur", eventName: "Concert", placeId: "oa:42" });
    expect(eventToLead({ uid: 1, title: "x" })).toBeNull();
  });
  it("exige clé et agendas, lit les événements à venir", async () => {
    const repo = await mkRepo();
    await expect(scanOpenAgenda(repo, "", ["1234"], 10)).rejects.toThrow(/Clé/);
    await expect(scanOpenAgenda(repo, "k", [], 10)).rejects.toThrow(/agenda/);
    let url = "";
    const f = (async (u: string) => ((url = u), ok({ events: [{ uid: 1, title: "A", location: { name: "Salle" } }] }))) as any;
    const r = await scanOpenAgenda(repo, "k", ["1234"], 10, f);
    expect(r.added).toBe(1);
    expect(url).toContain("/agendas/1234/events");
    expect(url).toContain("relative[]=upcoming");
  });
});

describe("runScan", () => {
  it("une source en erreur n'empêche pas les autres", async () => {
    const repo = await mkRepo();
    const f = (async (u: string) => {
      if (String(u).includes("overpass")) return { ok: false, status: 503, json: async () => ({}) };
      return ok({ results: [{ nom_complet: "NEUF", etat_administratif: "A", siege: { siret: "9", date_creation: "2026-09-01" } }] });
    }) as any;
    const r = await runScan(repo, { ...DEFAULT_SCAN, categories: ["bars"], sources: { osm: true, sirene: true, openagenda: false } }, { fetchImpl: f });
    expect(r.source).toBe("SIRENE");
    expect(r.errors?.[0]).toMatch(/OpenStreetMap/);
    await expect(runScan(repo, { ...DEFAULT_SCAN, sources: { osm: false, sirene: false, openagenda: false } })).rejects.toThrow(/source/);
  });
  it("normalise les nouveaux réglages", () => {
    const s = normalizeScan({ agendaUids: ["123456", "abc", "123456"], sireneMonths: 999, sources: { osm: false, sirene: true, openagenda: true } });
    expect(s.agendaUids).toEqual(["123456"]);
    expect(s.sireneMonths).toBe(120);
    expect(s.sources.osm).toBe(false);
  });
});

describe("analyse de site", () => {
  const html = `<html><head><title>Chez Zaza</title></head><body>© 2018 Chez Zaza
    <img src=a.jpg><a href="https://www.instagram.com/chezzaza/">ig</a> contact: <a href="mailto:contact@chezzaza.fr">x</a> logo@2x.png</body></html>`;
  it("extrait les signaux", () => {
    const s = extractSignals(html);
    expect(s).toMatchObject({ title: "Chez Zaza", hasViewport: false, imageCount: 1, hasVideo: false, copyrightYear: 2018 });
    expect(s.socials.instagram).toContain("chezzaza");
    expect(s.emails).toEqual(["contact@chezzaza.fr"]);
  });
  it("score et choix d'email", () => {
    const { score, reasons } = scoreSite({ reachable: true, ...extractSignals(html) }, 2026);
    expect(score).toBe(65); // mobile 20 + images 20 + vidéo 10 + ©2018 15
    expect(reasons.join()).toMatch(/Instagram/);
    expect(scoreSite({ reachable: false, hasViewport: false, imageCount: 0, hasVideo: false, copyrightYear: null, socials: {}, emails: [] }).score).toBe(60);
    expect(pickEmail(["a@gmail.com", "b@zaza.fr"], "https://www.zaza.fr")).toBe("b@zaza.fr");
  });
  it("refuse les hôtes privés (anti-SSRF)", () => {
    for (const h of ["localhost", "127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254", "172.20.0.1", "intranet", "[::1]", "nas.local"]) expect(isPublicHost(h)).toBe(false);
    expect(isPublicHost("chezzaza.fr")).toBe(true);
    expect(isPublicHost("8.8.8.8")).toBe(true);
  });
  it("analyzeLead met à jour score, email et date d'analyse ; pas d'appel réseau vers un hôte privé", async () => {
    const repo = await mkRepo();
    const lead = repo.createLead({ name: "Zaza", website: "https://chezzaza.fr" });
    const f = (async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => html })) as any;
    const r = await analyzeLead(repo, lead, f);
    expect(r.lead).toMatchObject({ gapScore: 65, email: "contact@chezzaza.fr" });
    expect(r.lead.analyzedAt).toBeTruthy();
    let called = false;
    const bad = repo.createLead({ name: "Interne", website: "http://192.168.0.1/admin" });
    const r2 = await analyzeLead(repo, bad, (async () => ((called = true), ok(""))) as any);
    expect(called).toBe(false);
    expect(r2.lead.gapScore).toBe(60);
  });
  it("outil analyze_lead : sans argument, prend les leads non analysés avec site", async () => {
    const repo = await mkRepo();
    repo.createLead({ name: "A", website: "https://a.fr" });
    repo.createLead({ name: "B" });
    const seen: string[] = [];
    const deps = {
      repo,
      generateDraft: async () => ({ draft: { subject: "", bodyHtml: "", hookUsed: "", confidence: 0 }, engine: "t" }),
      analyze: async (l: any) => (seen.push(l.name), { lead: l, signals: null }),
    };
    await executeTool(deps, { id: "1", name: "analyze_lead", args: {} });
    expect(seen).toEqual(["A"]);
  });
});
