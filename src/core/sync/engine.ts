import type { Repo, SyncTbl } from "../repo";
import type { Remote } from "./firestore";

type Row = Record<string, unknown>;
export type Tbl = SyncTbl;
/** Dans cet ordre : les leads existent avant leurs brouillons, les conversations avant leurs messages */
export const ALL_TABLES: Tbl[] = ["suppression", "leads", "drafts", "conversations", "messages", "jobs"];
/** Lignes qui ne changent jamais une fois écrites : la première version fait foi */
const IMMUTABLE: Tbl[] = ["suppression", "messages"];
const MAX_DOC = 900_000; // Firestore refuse un document de plus de 1 Mo : on ne pousse pas les messages démesurés
const JOB_RANK: Record<string, number> = { pending: 0, running: 1, done: 2, error: 2 };
const eq = (a: Row, b: Row) => Object.keys(a).every((k) => a[k] === b[k]);
const LEAD_RANK: Record<string, number> = { new: 0, drafted: 1, skipped: 1, sent: 2, replied: 3 };
const DRAFT_RANK: Record<string, number> = { draft: 0, approved: 1, sent: 2 };
const now = () => new Date().toISOString();

/**
 * Fusion « la dernière modification gagne », avec une exception de sécurité : un statut « envoyé » / « répondu »
 * ne peut jamais être écrasé par une copie plus ancienne (sinon l'iPad pourrait faire renvoyer un mail déjà parti).
 */
export function mergeRows(tbl: Tbl, local: Row, remote: Row): { row: Row; changedVsRemote: boolean } {
  if (IMMUTABLE.includes(tbl)) return { row: local, changedVsRemote: false };
  if (tbl === "jobs") {
    // Une commande ne fait qu'avancer (en attente → en cours → terminée) : l'état le plus avancé gagne
    const a = JOB_RANK[String(local.status)] ?? 0;
    const b = JOB_RANK[String(remote.status)] ?? 0;
    const win = a !== b ? (a > b ? local : remote) : String(remote.updated_at) > String(local.updated_at) ? remote : local;
    return { row: { ...win }, changedVsRemote: !eq(win, remote) };
  }
  if (tbl === "conversations") {
    const win = String(remote.updated_at) > String(local.updated_at) ? remote : local;
    const row = { ...win, deleted: Number(local.deleted) || Number(remote.deleted) ? 1 : 0 }; // une suppression est définitive
    return { row, changedVsRemote: !eq(row, remote) };
  }
  const lu = String(local.updated_at);
  const ru = String(remote.updated_at);
  const win = ru > lu ? remote : local;
  const row = { ...win };
  const rank = tbl === "leads" ? LEAD_RANK : DRAFT_RANK;
  const a = rank[String(local.status)] ?? 0;
  const b = rank[String(remote.status)] ?? 0;
  if (Math.max(a, b) >= 2 && (rank[String(win.status)] ?? 0) < Math.max(a, b)) {
    row.status = a >= b ? local.status : remote.status;
  }
  const changedVsRemote = row.status !== remote.status || row.updated_at !== remote.updated_at;
  if (row.status !== win.status) row.updated_at = now() > String(row.updated_at) ? now() : row.updated_at;
  return { row, changedVsRemote };
}

export interface SyncReport {
  pulled: number;
  pushed: number;
  error?: string;
}

/** Synchronisation bidirectionnelle (tirer puis pousser). Idempotente : on peut la relancer à tout moment. */
export async function syncOnce(repo: Repo, remote: Remote, tables: Tbl[] = ALL_TABLES): Promise<SyncReport> {
  const rep: SyncReport = { pulled: 0, pushed: 0 };

  // 1) Tirer
  for (const tbl of tables) {
    const stateKey = `pull:${tbl}`;
    let since = repo.getSyncState(stateKey);
    for (let page = 0; page < 50; page++) {
      const docs = await remote.pull(tbl, since, 300);
      for (const d of docs) {
        let remoteRow: Row;
        try {
          remoteRow = JSON.parse(d.j) as Row;
        } catch {
          continue;
        }
        const key = tbl === "suppression" ? "email" : "id";
        const local = repo.getRow(tbl, d.id);
        if (tbl === "messages") {
          // Un message n'est gardé que si sa conversation existe ici et n'a pas été supprimée
          const conv = repo.getRow("conversations", String(remoteRow.conversation_id));
          if (!local && conv && !conv.deleted && repo.putRow(tbl, { ...remoteRow, [key]: d.id })) rep.pulled++;
          repo.markSynced(tbl, d.id, d.u);
        } else if (!local) {
          if (repo.putRow(tbl, { ...remoteRow, [key]: d.id })) rep.pulled++;
          if (tbl === "conversations" && remoteRow.deleted) repo.purgeMessages(d.id);
          repo.markSynced(tbl, d.id, d.u);
        } else if (!IMMUTABLE.includes(tbl)) {
          const { row } = mergeRows(tbl, local, remoteRow);
          if (!eq(row, local)) {
            repo.putRow(tbl, row);
            rep.pulled++;
            if (tbl === "conversations" && row.deleted) repo.purgeMessages(d.id);
          }
          // Si la fusion a gardé / modifié notre version, elle sera repoussée (updated_at ≠ meta) ; sinon elle est à jour
          if (eq(row, remoteRow)) repo.markSynced(tbl, d.id, d.u);
        } else {
          repo.markSynced(tbl, d.id, d.u);
        }
      }
      if (docs.length) since = docs[docs.length - 1]!.p;
      if (docs.length < 300) break;
    }
    if (since) repo.setSyncState(stateKey, since);
  }

  // 2) Pousser
  for (const tbl of tables) {
    for (;;) {
      const dirty = repo.dirtyRows(tbl, 200);
      if (!dirty.length) break;
      const writes = dirty.map((d) => ({ col: tbl, id: d.id, u: d.u, j: JSON.stringify(d.row) }));
      await remote.commit(writes.filter((w) => w.j.length <= MAX_DOC));
      for (const d of dirty) repo.markSynced(tbl, d.id, d.u);
      rep.pushed += dirty.length;
    }
  }
  return rep;
}
