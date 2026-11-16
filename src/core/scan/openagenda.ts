import type { Repo } from "../repo";
import type { LeadInput } from "../types";

type F = typeof fetch;
const loc = (v: unknown): string | null => {
  if (typeof v === "string") return v.trim() || null;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const x = o.fr ?? Object.values(o).find((y) => typeof y === "string");
    return typeof x === "string" ? x.trim() || null : null;
  }
  return null;
};

interface OaEvent {
  uid?: number | string;
  title?: unknown;
  canonicalUrl?: string;
  firstTiming?: { begin?: string };
  timings?: { begin?: string }[];
  location?: { name?: string; address?: string; city?: string; adminLevel4?: string; postalCode?: string; website?: string };
}

export function eventToLead(e: OaEvent): LeadInput | null {
  const title = loc(e.title);
  const place = e.location?.name?.trim();
  if (!title || !place || e.uid == null) return null;
  const begin = e.firstTiming?.begin ?? e.timings?.[0]?.begin ?? null;
  const city = e.location?.city ?? e.location?.adminLevel4 ?? null;
  return {
    kind: "event",
    name: place,
    category: "Événement",
    city,
    address: [e.location?.address, e.location?.postalCode].filter(Boolean).join(", ") || null,
    website: e.location?.website ?? null,
    eventName: title,
    eventDate: begin,
    eventUrl: e.canonicalUrl ?? null,
    placeId: `oa:${e.uid}`,
    gapScore: 40,
    gapReasons: ["Événement à venir : besoin potentiel de photo/vidéo (à qualifier)"],
    source: "openagenda",
  };
}

export async function scanOpenAgenda(repo: Repo, key: string, uids: string[], max: number, f: F = fetch, onLog?: (l: string) => void) {
  if (!key) throw new Error("Clé OpenAgenda manquante (Réglages)");
  if (!uids.length) throw new Error("Aucun agenda OpenAgenda configuré (Réglages)");
  let found = 0;
  let added = 0;
  let duplicates = 0;
  for (const uid of uids) {
    const url = `https://api.openagenda.com/v2/agendas/${uid}/events?key=${encodeURIComponent(key)}&relative[]=upcoming&detailed=1&size=100`;
    const res = await f(url, { signal: AbortSignal.timeout(30_000) });
    if (res.status === 401 || res.status === 403) throw new Error("Clé OpenAgenda refusée");
    if (!res.ok) {
      onLog?.(`OpenAgenda agenda ${uid} : HTTP ${res.status}`);
      continue;
    }
    const j = (await res.json()) as { events?: OaEvent[] };
    for (const ev of j.events ?? []) {
      const l = eventToLead(ev);
      if (!l) continue;
      found++;
      if (added >= max) continue;
      try {
        repo.createLead(l);
        added++;
      } catch {
        duplicates++;
      }
    }
  }
  onLog?.(`OpenAgenda : ${found} événements, ${added} ajoutés.`);
  return { found, added, duplicates, source: "OpenAgenda" };
}
