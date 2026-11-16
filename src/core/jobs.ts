import type { Job, JobKind, Repo } from "./repo";

/**
 * Commandes envoyées depuis l'iPad et exécutées par le PC (scan, analyse de site, envoi de mail).
 * Le navigateur ne peut pas les faire lui-même ; le PC les exécute dès qu'il est allumé, avec exactement
 * les mêmes garde-fous que s'il les lançait lui-même (brouillon validé, plafond du jour, désinscrits…).
 */
export interface JobRunners {
  scan(overrides: { categories?: string[]; radiusKm?: number }): Promise<string>;
  analyze(leadId: string): Promise<string>;
  /** Doit lever une erreur (message lisible) si l'envoi est refusé */
  send(draftId: string): Promise<string>;
  sendApproved(): Promise<string>;
}

const HOUR = 3_600_000;
/** Au-delà, une commande en attente est abandonnée : on ne veut pas qu'un mail parte le lendemain d'un clic oublié. */
export const JOB_TTL_MS: Record<JobKind, number> = { send: 12 * HOUR, send_approved: 12 * HOUR, scan: 24 * HOUR, analyze: 24 * HOUR };
const KINDS = Object.keys(JOB_TTL_MS) as JobKind[];

/** Crée une commande (côté iPad). Une commande identique encore ouverte est réutilisée : un double clic n'envoie pas deux fois. */
export function enqueueJob(repo: Repo, kind: JobKind, params: Record<string, unknown> = {}): Job {
  if (!KINDS.includes(kind)) throw new Error("Commande inconnue");
  const clean: Record<string, unknown> = {};
  if (kind === "analyze") {
    if (typeof params.leadId !== "string" || !params.leadId) throw new Error("Lead manquant");
    clean.leadId = params.leadId;
  } else if (kind === "send") {
    if (typeof params.draftId !== "string" || !params.draftId) throw new Error("Brouillon manquant");
    clean.draftId = params.draftId;
  } else if (kind === "scan") {
    if (Array.isArray(params.categories)) clean.categories = params.categories.filter((c): c is string => typeof c === "string").slice(0, 20);
    if (Number(params.radiusKm) > 0) clean.radiusKm = Math.min(Number(params.radiusKm), 50);
  }
  const same = repo.openJobs().find((j) => j.kind === kind && JSON.stringify(j.params) === JSON.stringify(clean));
  return same ?? repo.createJob(kind, clean);
}

let running = false;

/** Exécute les commandes en attente (côté PC), une à la fois. Retourne le nombre de commandes traitées. */
export async function processJobs(repo: Repo, run: JobRunners, o: { now?: Date; onChange?: () => void } = {}): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    const t = (o.now ?? new Date()).getTime();
    let n = 0;
    for (const j of repo.openJobs()) {
      if (j.status === "running") {
        // Personne d'autre que nous n'exécute : une commande « en cours » est restée coincée (app fermée). On ne la relance jamais seule.
        repo.setJobStatus(j.id, "error", "Interrompue (l'app PC s'est fermée pendant l'exécution). Vérifie le résultat puis relance si besoin.");
      } else if (t - Date.parse(j.createdAt) > JOB_TTL_MS[j.kind]) {
        repo.setJobStatus(j.id, "error", "Expirée : le PC était éteint depuis trop longtemps. Relance la commande.");
      } else {
        repo.setJobStatus(j.id, "running");
        o.onChange?.();
        n++;
        try {
          repo.setJobStatus(j.id, "done", await exec(run, j));
        } catch (e) {
          repo.setJobStatus(j.id, "error", (e as Error).message || "Échec");
        }
      }
      o.onChange?.();
    }
    return n;
  } finally {
    running = false;
  }
}

function exec(run: JobRunners, j: Job): Promise<string> {
  switch (j.kind) {
    case "scan":
      return run.scan({
        categories: Array.isArray(j.params.categories) ? (j.params.categories as string[]) : undefined,
        radiusKm: typeof j.params.radiusKm === "number" ? j.params.radiusKm : undefined,
      });
    case "analyze":
      return run.analyze(String(j.params.leadId));
    case "send":
      return run.send(String(j.params.draftId));
    case "send_approved":
      return run.sendApproved();
    default:
      return Promise.reject(new Error("Commande inconnue"));
  }
}
