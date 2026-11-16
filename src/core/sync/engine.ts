import type { Repo } from "../repo";
import type { Remote } from "./firestore";

type Row = Record<string, unknown>;
type Tbl = "leads" | "drafts" | "suppression";
const TABLES: Tbl[] = ["suppression", "leads", "drafts"]; // dans cet ordre : les leads existent avant leurs brouillons
const LEAD_RANK: Record<string, number> = { new: 0, drafted: 1, skipped: 1, sent: 2, replied: 3 };
const DRAFT_RANK: Record<string, number> = { draft: 0, approved: 1, sent: 2 };
const now = () => new Date().toISOString();

/**
 * Fusion « la dernière modification gagne », avec une exception de sécurité : un statut « envoyé » / « répondu »
 * ne peut jamais être écrasé par une copie plus ancienne (sinon l'iPad pourrait faire renvoyer un mail déjà parti).
 */
export function mergeRows(tbl: Tbl, local: Row, remote: Row): { row: Row; changedVsRemote: boolean } {
  if (tbl === "suppression") return { row: local, changedVsRemote: false };
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
export async function syncOnce(repo: Repo, remote: Remote): Promise<SyncReport> {
  const rep: SyncReport = { pulled: 0, pushed: 0 };

  // 1) Tirer
  for (const tbl of TABLES) {
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
        if (!local) {
          if (repo.putRow(tbl, { ...remoteRow, [key]: d.id })) rep.pulled++;
          repo.markSynced(tbl, d.id, d.u);
        } else if (tbl !== "suppression") {
          const { row } = mergeRows(tbl, local, remoteRow);
          const same = row.updated_at === local.updated_at && row.status === local.status;
          if (!same) {
            repo.putRow(tbl, row);
            rep.pulled++;
          }
          // Si la fusion a gardé / modifié notre version, elle sera repoussée (updated_at ≠ meta) ; sinon elle est à jour
          if (row.updated_at === remoteRow.updated_at && row.status === remoteRow.status) repo.markSynced(tbl, d.id, d.u);
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
  for (const tbl of TABLES) {
    for (;;) {
      const dirty = repo.dirtyRows(tbl, 200);
      if (!dirty.length) break;
      await remote.commit(dirty.map((d) => ({ col: tbl, id: d.id, u: d.u, j: JSON.stringify(d.row) })));
      for (const d of dirty) repo.markSynced(tbl, d.id, d.u);
      rep.pushed += dirty.length;
    }
  }
  return rep;
}
