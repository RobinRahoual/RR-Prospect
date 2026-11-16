import type { Repo } from "../repo";
import type { LeadInput } from "../types";
import { SCAN_CATEGORIES, type ScanSettings } from "./settings";

const BASE = "https://recherche-entreprises.api.gouv.fr/near_point";
const UA = "RR-Prospect/0.3 (https://robinrahoual.fr)";
type F = typeof fetch;

interface Item {
  nom_complet?: string;
  siren?: string;
  date_creation?: string | null;
  etat_administratif?: string;
  activite_principale?: string;
  siege?: { siret?: string; adresse?: string; libelle_commune?: string; date_creation?: string | null; latitude?: string | null; longitude?: string | null };
}

const monthsSince = (iso: string, now = new Date()): number => {
  const d = new Date(iso);
  return (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
};

export function itemToLead(it: Item, categoryLabel: string, maxMonths: number, now = new Date()): LeadInput | null {
  const name = it.nom_complet?.trim();
  const created = it.siege?.date_creation ?? it.date_creation ?? null;
  if (!name || !created || it.etat_administratif === "C") return null;
  const age = monthsSince(created, now);
  if (age < 0 || age > maxMonths) return null;
  return {
    kind: "business",
    name,
    category: categoryLabel,
    city: it.siege?.libelle_commune ?? null,
    address: it.siege?.adresse ?? null,
    placeId: `siret:${it.siege?.siret ?? it.siren}`,
    // Une entreprise toute récente n'a en général pas encore de contenu visuel
    gapScore: Math.max(20, Math.min(60, 60 - age * 2)),
    gapReasons: [`Entreprise créée il y a ${age} mois (SIRENE) : présence visuelle probablement à construire`],
    source: "sirene",
  };
}

async function getJson(f: F, url: string): Promise<{ results?: Item[] }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await f(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 429) {
      const wait = Math.min(Number(res.headers?.get?.("retry-after")) || 1, 5);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as { results?: Item[] };
  }
  throw new Error("trop de requêtes (429)");
}

export async function scanSirene(repo: Repo, s: ScanSettings, f: F = fetch, onLog?: (l: string) => void, now = new Date()) {
  const seen = new Set<string>();
  const cands: LeadInput[] = [];
  let errors = 0;
  for (const id of s.categories) {
    const cat = SCAN_CATEGORIES.find((c) => c.id === id);
    if (!cat) continue;
    for (const naf of cat.naf) {
      for (let page = 1; page <= 3; page++) {
        const url = `${BASE}?lat=${s.lat}&long=${s.lon}&radius=${Math.min(s.radiusKm, 50)}&activite_principale=${encodeURIComponent(naf)}&per_page=25&page=${page}`;
        let data: { results?: Item[] };
        try {
          data = await getJson(f, url);
        } catch (e) {
          errors++;
          onLog?.(`SIRENE ${naf} : ${(e as Error).message}`);
          break;
        }
        const items = data.results ?? [];
        for (const it of items) {
          const l = itemToLead(it, cat.label, s.sireneMonths, now);
          if (l && !seen.has(l.placeId!)) {
            seen.add(l.placeId!);
            cands.push(l);
          }
        }
        if (items.length < 25) break;
        await new Promise((r) => setTimeout(r, 200)); // limite : 7 requêtes/s
      }
    }
  }
  if (errors && !cands.length) throw new Error("API Recherche d'entreprises indisponible");
  cands.sort((a, b) => (b.gapScore ?? 0) - (a.gapScore ?? 0));
  let added = 0;
  let duplicates = 0;
  for (const c of cands) {
    if (added >= s.maxResults) break;
    if (repo.hasLeadNamed(c.name)) {
      duplicates++;
      continue;
    }
    try {
      repo.createLead(c);
      added++;
    } catch {
      duplicates++;
    }
  }
  onLog?.(`SIRENE : ${cands.length} entreprises récentes, ${added} ajoutées.`);
  return { found: cands.length, added, duplicates, source: "SIRENE" };
}
