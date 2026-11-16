import type { Repo } from "../repo";
import type { LeadInput } from "../types";
import { SCAN_CATEGORIES, type ScanSettings } from "./settings";

const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const UA = "RR-Prospect/0.3 (https://robinrahoual.fr)";

type F = typeof fetch;
interface OsmEl {
  type: string;
  id: number;
  tags?: Record<string, string>;
}

export interface GeoResult {
  label: string;
  lat: number;
  lon: number;
}

/** Nominatim (OpenStreetMap) : gratuit, 1 requête par action de l'utilisateur. */
export async function geocode(query: string, f: F = fetch): Promise<GeoResult> {
  const q = query.trim();
  if (!q) throw new Error("Saisis un lieu");
  const res = await f(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`, {
    headers: { "User-Agent": UA, "Accept-Language": "fr" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Recherche du lieu impossible (HTTP ${res.status})`);
  const j = (await res.json()) as { lat: string; lon: string; display_name: string }[];
  if (!j[0]) throw new Error(`Lieu introuvable : « ${q} »`);
  return { label: j[0].display_name.split(",").slice(0, 2).join(",").trim(), lat: Number(j[0].lat), lon: Number(j[0].lon) };
}

export function buildOverpassQuery(s: ScanSettings): string {
  const around = `(around:${Math.round(s.radiusKm * 1000)},${s.lat},${s.lon})`;
  const parts: string[] = [];
  for (const id of s.categories) {
    const cat = SCAN_CATEGORIES.find((c) => c.id === id);
    if (!cat) continue;
    for (const t of cat.tags) parts.push(`nwr["${t.key}"~"^(${t.values.join("|")})$"]["name"]${around};`);
  }
  return `[out:json][timeout:60];(${parts.join("")});out center tags 2000;`;
}

const first = (t: Record<string, string>, ...keys: string[]) => keys.map((k) => t[k]?.trim()).find(Boolean) ?? null;
const SOCIAL = /(facebook|instagram|fb\.com|linktr\.ee)/i;

export function elementToLead(el: OsmEl, categoryLabel: string, city: string | null): LeadInput | null {
  const t = el.tags ?? {};
  const name = t.name?.trim();
  if (!name) return null;
  let website = first(t, "website", "contact:website", "url");
  if (website && !/^https?:\/\//i.test(website)) website = `https://${website}`;
  const social = first(t, "contact:instagram", "instagram", "contact:facebook", "facebook");
  const reasons: string[] = [];
  let score = 0;
  if (!website) {
    score += 40;
    reasons.push("Aucun site web renseigné");
  } else if (SOCIAL.test(website)) {
    score += 30;
    reasons.push("Le « site » est une simple page de réseau social");
  }
  if (!social && !(website && SOCIAL.test(website))) {
    score += 10;
    reasons.push("Aucun réseau social renseigné (à vérifier)");
  }
  const addr = [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ");
  const place = [t["addr:postcode"], t["addr:city"]].filter(Boolean).join(" ");
  return {
    kind: "business",
    name,
    category: categoryLabel,
    city: t["addr:city"] ?? city,
    address: [addr, place].filter(Boolean).join(", ") || null,
    website,
    email: first(t, "email", "contact:email"),
    phone: first(t, "phone", "contact:phone", "contact:mobile"),
    placeId: `osm:${el.type}/${el.id}`,
    gapScore: Math.min(score, 100),
    gapReasons: reasons,
    source: "osm",
  };
}

function categoryOf(t: Record<string, string>): string {
  for (const c of SCAN_CATEGORIES) {
    if (c.tags.some((x) => x.values.includes(t[x.key] ?? ""))) return c.label;
  }
  return "Autre";
}

export interface ScanReport {
  found: number;
  added: number;
  duplicates: number;
  source: string;
}

export async function scanArea(repo: Repo, s: ScanSettings, f: F = fetch, onLog?: (l: string) => void): Promise<ScanReport> {
  const body = `data=${encodeURIComponent(buildOverpassQuery(s))}`;
  let data: { elements?: OsmEl[] } | null = null;
  let lastErr = "";
  for (const url of OVERPASS) {
    try {
      onLog?.(`Interrogation de ${new URL(url).host}…`);
      const res = await f(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
        body,
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        continue;
      }
      data = (await res.json()) as { elements?: OsmEl[] };
      break;
    } catch (e) {
      lastErr = (e as Error).message;
    }
  }
  if (!data) throw new Error(`OpenStreetMap indisponible (${lastErr}). Réessaie dans quelques minutes.`);

  const cands = (data.elements ?? [])
    .map((el) => elementToLead(el, categoryOf(el.tags ?? {}), s.placeLabel.split(",")[0] ?? null))
    .filter((l): l is LeadInput => !!l)
    .sort((a, b) => (b.gapScore ?? 0) - (a.gapScore ?? 0));

  let added = 0;
  let duplicates = 0;
  for (const c of cands) {
    if (added >= s.maxResults) break;
    try {
      repo.createLead(c);
      added++;
    } catch {
      duplicates++;
    }
  }
  onLog?.(`${cands.length} établissements trouvés, ${added} ajoutés.`);
  return { found: cands.length, added, duplicates, source: "OpenStreetMap" };
}
