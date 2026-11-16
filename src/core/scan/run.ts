import type { Repo } from "../repo";
import { scanOpenAgenda } from "./openagenda";
import { scanArea, type ScanReport } from "./osm";
import { scanSirene } from "./sirene";
import type { ScanSettings } from "./settings";

/** Lance toutes les sources activées. Une source en erreur n'empêche pas les autres. */
export async function runScan(
  repo: Repo,
  s: ScanSettings,
  o: { openAgendaKey?: string | null; fetchImpl?: typeof fetch; onLog?: (l: string) => void } = {}
): Promise<ScanReport> {
  const f = o.fetchImpl ?? fetch;
  const names: string[] = [];
  const errors: string[] = [];
  const total = { found: 0, added: 0, duplicates: 0 };
  const jobs: [string, () => Promise<ScanReport>][] = [];
  if (s.sources.osm) jobs.push(["OpenStreetMap", () => scanArea(repo, s, f, o.onLog)]);
  if (s.sources.sirene) jobs.push(["SIRENE", () => scanSirene(repo, s, f, o.onLog)]);
  if (s.sources.openagenda) jobs.push(["OpenAgenda", () => scanOpenAgenda(repo, o.openAgendaKey ?? "", s.agendaUids, s.maxResults, f, o.onLog)]);
  if (!jobs.length) throw new Error("Active au moins une source dans Réglages");
  for (const [name, job] of jobs) {
    try {
      const r = await job();
      names.push(name);
      total.found += r.found;
      total.added += r.added;
      total.duplicates += r.duplicates;
    } catch (e) {
      errors.push(`${name} : ${(e as Error).message}`);
      o.onLog?.(`${name} : ${(e as Error).message}`);
    }
  }
  if (!names.length) throw new Error(errors.join(" · "));
  return { ...total, source: names.join(" + "), errors: errors.length ? errors : undefined };
}
