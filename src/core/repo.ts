const randomUUID = (): string => globalThis.crypto.randomUUID();
import type { Database } from "./db-core";
import type { ChatMessage } from "./chat/types";
import { htmlToPlain } from "./chat/tools";
import type { Draft, DraftOut, DraftStatus, Lead, LeadInput, LeadStatus } from "./types";

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();
const str = (v: unknown) => (v == null ? null : String(v));
const num = (v: unknown) => (v == null ? null : Number(v));

function toLead(r: Row): Lead {
  return {
    id: String(r.id),
    kind: r.kind as Lead["kind"],
    name: String(r.name),
    category: str(r.category),
    city: str(r.city),
    address: str(r.address),
    website: str(r.website),
    email: str(r.email),
    phone: str(r.phone),
    placeId: str(r.place_id),
    rating: num(r.rating),
    photoCount: num(r.photo_count),
    lastReviewAt: str(r.last_review_at),
    gapScore: num(r.gap_score),
    gapReasons: r.gap_reasons ? (JSON.parse(String(r.gap_reasons)) as string[]) : [],
    eventName: str(r.event_name),
    eventDate: str(r.event_date),
    eventUrl: str(r.event_url),
    source: str(r.source),
    status: r.status as LeadStatus,
    analyzedAt: str(r.analyzed_at),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function toDraft(r: Row): Draft {
  return {
    id: String(r.id),
    leadId: String(r.lead_id),
    subject: String(r.subject),
    bodyHtml: String(r.body_html),
    hookUsed: String(r.hook_used ?? ""),
    confidence: Number(r.confidence ?? 0),
    engine: String(r.engine),
    status: r.status as DraftStatus,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export type JobKind = "scan" | "analyze" | "send" | "send_approved";
export type JobStatus = "pending" | "running" | "done" | "error";
export interface Job {
  id: string;
  kind: JobKind;
  params: Record<string, unknown>;
  status: JobStatus;
  result: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SyncTbl = "leads" | "drafts" | "suppression" | "conversations" | "messages" | "jobs";

export class Repo {
  constructor(private db: Database) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS leads (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
        category TEXT, city TEXT, address TEXT, website TEXT, email TEXT, phone TEXT,
        place_id TEXT UNIQUE, rating REAL, photo_count INTEGER, last_review_at TEXT,
        gap_score INTEGER, gap_reasons TEXT,
        event_name TEXT, event_date TEXT, event_url TEXT, source TEXT,
        status TEXT NOT NULL DEFAULT 'new',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, subject TEXT NOT NULL, body_html TEXT NOT NULL,
        hook_used TEXT, confidence REAL, engine TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS suppression (
        email TEXT PRIMARY KEY, reason TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_drafts_lead ON drafts(lead_id);
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
        tool_calls TEXT, tool_call_id TEXT, tool_name TEXT, raw TEXT, cards TEXT, engine TEXT,
        seq INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending',
        result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sends (
        id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, lead_id TEXT NOT NULL, to_email TEXT NOT NULL,
        subject TEXT NOT NULL, message_id TEXT, status TEXT NOT NULL, error TEXT, sent_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inbound (
        message_id TEXT PRIMARY KEY, lead_id TEXT, kind TEXT NOT NULL, from_email TEXT, subject TEXT,
        snippet TEXT, received_at TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_meta (
        tbl TEXT NOT NULL, id TEXT NOT NULL, u TEXT NOT NULL, PRIMARY KEY (tbl, id)
      );
      CREATE TABLE IF NOT EXISTS sync_state (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_sends_at ON sends(sent_at);
      CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, seq);
    `);
    this.addColumn("leads", "analyzed_at", "TEXT");
    this.addColumn("conversations", "deleted", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("sends", "track_id", "TEXT");
    this.addColumn("sends", "opens", "INTEGER DEFAULT 0");
    this.addColumn("sends", "first_open_at", "TEXT");
    this.addColumn("sends", "last_open_at", "TEXT");
  }

  /** Migrations légères : colonne ajoutée après la v0.3 */
  private addColumn(table: string, col: string, type: string): void {
    const has = this.db.all<Row>(`PRAGMA table_info(${table})`).some((r) => r.name === col);
    if (!has) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }

  private static norm(n: string): string {
    return n.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  }

  /** Même nom normalisé déjà présent (autre source, même commerce) */
  hasLeadNamed(name: string): boolean {
    const n = Repo.norm(name);
    return !!n && this.db.all<Row>("SELECT name FROM leads WHERE deleted = 0").some((r) => Repo.norm(String(r.name)) === n);
  }

  updateLead(id: string, p: Partial<Pick<Lead, "email" | "phone" | "website" | "gapScore" | "gapReasons">> & { analyzed?: boolean }): void {
    const cur = this.getLead(id);
    if (!cur) throw new Error("Lead introuvable");
    const m = { ...cur, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) } as Lead;
    this.db.run("UPDATE leads SET email = ?, phone = ?, website = ?, gap_score = ?, gap_reasons = ?, analyzed_at = ?, updated_at = ? WHERE id = ?", [
      m.email, m.phone, m.website, m.gapScore, m.gapReasons.length ? JSON.stringify(m.gapReasons) : null,
      p.analyzed ? now() : cur.analyzedAt, now(), id,
    ]);
  }

  createLead(i: LeadInput): Lead {
    if (i.placeId && this.db.all("SELECT 1 FROM leads WHERE place_id = ? AND deleted = 0", [i.placeId]).length) {
      throw new Error("Lead déjà présent (même fiche Google)");
    }
    const t = now();
    const id = randomUUID();
    this.db.run(
      `INSERT INTO leads (id, kind, name, category, city, address, website, email, phone, place_id, rating,
         photo_count, last_review_at, gap_score, gap_reasons, event_name, event_date, event_url, source,
         status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'new',?,?)`,
      [
        id, i.kind ?? "business", i.name.trim(), i.category, i.city, i.address, i.website, i.email, i.phone,
        i.placeId, i.rating, i.photoCount, i.lastReviewAt, i.gapScore,
        i.gapReasons?.length ? JSON.stringify(i.gapReasons) : null,
        i.eventName, i.eventDate, i.eventUrl, i.source, t, t,
      ]
    );
    return this.getLead(id)!;
  }

  getLead(id: string): Lead | null {
    const r = this.db.all<Row>("SELECT * FROM leads WHERE id = ? AND deleted = 0", [id])[0];
    return r ? toLead(r) : null;
  }

  listLeads(status?: LeadStatus): Lead[] {
    const rows = status
      ? this.db.all<Row>("SELECT * FROM leads WHERE deleted = 0 AND status = ? ORDER BY gap_score DESC, created_at DESC LIMIT 500", [status])
      : this.db.all<Row>("SELECT * FROM leads WHERE deleted = 0 ORDER BY gap_score DESC, created_at DESC LIMIT 500");
    return rows.map(toLead);
  }

  setLeadStatus(id: string, status: LeadStatus): void {
    this.db.run("UPDATE leads SET status = ?, updated_at = ? WHERE id = ?", [status, now(), id]);
  }

  addDraft(leadId: string, d: DraftOut, engine: string): Draft {
    const t = now();
    const id = randomUUID();
    this.db.run(
      `INSERT INTO drafts (id, lead_id, subject, body_html, hook_used, confidence, engine, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,'draft',?,?)`,
      [id, leadId, d.subject, d.bodyHtml, d.hookUsed, d.confidence, engine, t, t]
    );
    this.setLeadStatus(leadId, "drafted");
    return this.getDraft(id)!;
  }

  getDraft(id: string): Draft | null {
    const r = this.db.all<Row>("SELECT * FROM drafts WHERE id = ? AND deleted = 0", [id])[0];
    return r ? toDraft(r) : null;
  }

  listDrafts(leadId: string): Draft[] {
    return this.db
      .all<Row>("SELECT * FROM drafts WHERE lead_id = ? AND deleted = 0 ORDER BY created_at DESC", [leadId])
      .map(toDraft);
  }

  updateDraft(id: string, patch: { subject?: string; bodyHtml?: string; status?: DraftStatus }): Draft {
    const cur = this.getDraft(id);
    if (!cur) throw new Error("Brouillon introuvable");
    this.db.run("UPDATE drafts SET subject = ?, body_html = ?, status = ?, updated_at = ? WHERE id = ?", [
      patch.subject ?? cur.subject,
      patch.bodyHtml ?? cur.bodyHtml,
      patch.status ?? cur.status,
      now(),
      id,
    ]);
    return this.getDraft(id)!;
  }

  addSuppression(email: string, reason?: string): void {
    this.db.run("INSERT OR IGNORE INTO suppression (email, reason, created_at) VALUES (?,?,?)", [
      email.trim().toLowerCase(),
      reason ?? null,
      now(),
    ]);
  }

  isSuppressed(email: string): boolean {
    return this.db.all("SELECT 1 FROM suppression WHERE email = ?", [email.trim().toLowerCase()]).length > 0;
  }

  // ---- Envois ----
  recordSend(r: { draftId: string; leadId: string; to: string; subject: string; messageId: string | null; status: "sent" | "failed"; error?: string; trackId?: string | null }): void {
    this.db.run(
      "INSERT INTO sends (id, draft_id, lead_id, to_email, subject, message_id, status, error, sent_at, track_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [randomUUID(), r.draftId, r.leadId, r.to, r.subject, r.messageId, r.status, r.error ?? null, now(), r.trackId ?? null]
    );
  }

  /** Envois suivis des `days` derniers jours (pour interroger le Worker) */
  listTrackIds(days = 30): string[] {
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    return this.db
      .all<Row>("SELECT track_id FROM sends WHERE track_id IS NOT NULL AND status = 'sent' AND sent_at >= ?", [since])
      .map((r) => String(r.track_id));
  }

  setOpens(trackId: string, opens: number, first: number | null, last: number | null): void {
    this.db.run("UPDATE sends SET opens = ?, first_open_at = ?, last_open_at = ? WHERE track_id = ?", [
      opens, first ? new Date(first).toISOString() : null, last ? new Date(last).toISOString() : null, trackId,
    ]);
  }

  opensByLead(): Record<string, { opens: number; last: string | null }> {
    const out: Record<string, { opens: number; last: string | null }> = {};
    for (const r of this.db.all<Row>("SELECT lead_id, SUM(opens) AS n, MAX(last_open_at) AS last FROM sends WHERE track_id IS NOT NULL GROUP BY lead_id")) {
      if (Number(r.n) > 0) out[String(r.lead_id)] = { opens: Number(r.n), last: (r.last as string) ?? null };
    }
    return out;
  }

  /** Leads contactés il y a au moins `days` jours, sans réponse : candidats à la relance */
  followUps(days = 4): { leadId: string; name: string; email: string; sentAt: string; opens: number }[] {
    const before = new Date(Date.now() - days * 86400_000).toISOString();
    return this.db
      .all<Row>(
        `SELECT l.id, l.name, s.to_email, MAX(s.sent_at) AS sent_at, SUM(COALESCE(s.opens,0)) AS opens
         FROM sends s JOIN leads l ON l.id = s.lead_id
         WHERE s.status = 'sent' AND l.status = 'sent' AND l.deleted = 0
         GROUP BY l.id HAVING MAX(s.sent_at) <= ? ORDER BY MAX(s.sent_at)`,
        [before]
      )
      .map((r) => ({ leadId: String(r.id), name: String(r.name), email: String(r.to_email), sentAt: String(r.sent_at), opens: Number(r.opens) }))
      .filter((f) => !this.isSuppressed(f.email));
  }

  countSentSince(iso: string): number {
    return Number(this.db.all<Row>("SELECT COUNT(*) AS n FROM sends WHERE status = 'sent' AND sent_at >= ?", [iso])[0]?.n ?? 0);
  }

  // ---- Boîte de réception ----
  hasInbound(messageId: string): boolean {
    return this.db.all("SELECT 1 FROM inbound WHERE message_id = ?", [messageId]).length > 0;
  }

  recordInbound(r: { messageId: string; leadId: string | null; kind: string; from: string; subject: string; snippet: string; date: string }): void {
    this.db.run(
      "INSERT OR IGNORE INTO inbound (message_id, lead_id, kind, from_email, subject, snippet, received_at, created_at) VALUES (?,?,?,?,?,?,?,?)",
      [r.messageId, r.leadId, r.kind, r.from, r.subject, r.snippet, r.date, now()]
    );
  }

  listInbound(limit = 30): { leadId: string; leadName: string; kind: string; from: string; subject: string; snippet: string; date: string }[] {
    return this.db
      .all<Row>(
        `SELECT i.*, l.name AS lead_name FROM inbound i JOIN leads l ON l.id = i.lead_id
         WHERE i.kind != 'ignore' ORDER BY i.received_at DESC LIMIT ?`,
        [limit]
      )
      .map((r) => ({
        leadId: String(r.lead_id), leadName: String(r.lead_name), kind: String(r.kind), from: String(r.from_email ?? ""),
        subject: String(r.subject ?? ""), snippet: String(r.snippet ?? ""), date: String(r.received_at ?? ""),
      }));
  }

  /** Date du premier envoi (borne de recherche dans la boîte) */
  firstSendAt(): string | null {
    return (this.db.all<Row>("SELECT MIN(sent_at) AS d FROM sends WHERE status = 'sent'")[0]?.d as string) ?? null;
  }

  // ---- Synchronisation (voir sync/engine.ts) ----
  getSyncState(k: string): string | null {
    return (this.db.all<Row>("SELECT v FROM sync_state WHERE k = ?", [k])[0]?.v as string) ?? null;
  }

  setSyncState(k: string, v: string): void {
    this.db.run("INSERT OR REPLACE INTO sync_state (k, v) VALUES (?, ?)", [k, v]);
  }

  /** Lignes modifiées depuis leur dernière synchronisation (jamais vues, ou changées depuis) */
  dirtyRows(tbl: SyncTbl, limit = 200): { id: string; u: string; row: Row }[] {
    const key = tbl === "suppression" ? "email" : "id";
    const ucol = tbl === "suppression" || tbl === "messages" ? "created_at" : "updated_at";
    return this.db
      .all<Row>(
        `SELECT t.* FROM ${tbl} t LEFT JOIN sync_meta m ON m.tbl = ? AND m.id = t.${key}
         WHERE m.u IS NULL OR m.u <> t.${ucol} LIMIT ?`,
        [tbl, limit]
      )
      .map((row) => ({ id: String(row[key]), u: String(row[ucol]), row }));
  }

  markSynced(tbl: string, id: string, u: string): void {
    this.db.run("INSERT OR REPLACE INTO sync_meta (tbl, id, u) VALUES (?,?,?)", [tbl, id, u]);
  }

  getRow(tbl: SyncTbl, id: string): Row | null {
    const key = tbl === "suppression" ? "email" : "id";
    return this.db.all<Row>(`SELECT * FROM ${tbl} WHERE ${key} = ?`, [id])[0] ?? null;
  }

  /** Insère ou met à jour une ligne brute (colonnes inconnues ignorées). Retourne false si refusée (doublon de fiche Google). */
  putRow(tbl: SyncTbl, row: Row): boolean {
    const key = tbl === "suppression" ? "email" : "id";
    const cols = this.db.all<Row>(`PRAGMA table_info(${tbl})`).map((c) => String(c.name));
    const keys = Object.keys(row).filter((k) => cols.includes(k));
    if (tbl === "leads" && row.place_id) {
      const clash = this.db.all<Row>("SELECT id FROM leads WHERE place_id = ? AND id <> ?", [row.place_id, row.id]);
      if (clash.length) return false;
    }
    if (this.getRow(tbl, String(row[key]))) {
      const sets = keys.filter((k) => k !== key);
      if (sets.length) this.db.run(`UPDATE ${tbl} SET ${sets.map((k) => `${k} = ?`).join(", ")} WHERE ${key} = ?`, [...sets.map((k) => row[k]), row[key]]);
    } else {
      this.db.run(`INSERT INTO ${tbl} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`, keys.map((k) => row[k]));
    }
    return true;
  }

  // ---- Commandes iPad → PC (voir jobs.ts) ----
  private rowToJob(r: Row): Job {
    let params: Record<string, unknown> = {};
    try {
      params = JSON.parse(String(r.params ?? "{}")) as Record<string, unknown>;
    } catch {
      /* paramètres illisibles : ignorés */
    }
    return { id: String(r.id), kind: r.kind as JobKind, params, status: r.status as JobStatus, result: (r.result as string) ?? null, createdAt: String(r.created_at), updatedAt: String(r.updated_at) };
  }

  createJob(kind: JobKind, params: Record<string, unknown> = {}): Job {
    const t = now();
    const id = randomUUID();
    this.db.run("INSERT INTO jobs (id, kind, params, status, created_at, updated_at) VALUES (?,?,?,?,?,?)", [id, kind, JSON.stringify(params), "pending", t, t]);
    return this.getJob(id)!;
  }

  getJob(id: string): Job | null {
    const r = this.db.all<Row>("SELECT * FROM jobs WHERE id = ?", [id])[0];
    return r ? this.rowToJob(r) : null;
  }

  listJobs(limit = 20): Job[] {
    return this.db.all<Row>("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", [limit]).map((r) => this.rowToJob(r));
  }

  /** Commandes à traiter ou en cours, les plus anciennes d'abord */
  openJobs(): Job[] {
    return this.db.all<Row>("SELECT * FROM jobs WHERE status IN ('pending','running') ORDER BY created_at").map((r) => this.rowToJob(r));
  }

  setJobStatus(id: string, status: JobStatus, result?: string): void {
    this.db.run("UPDATE jobs SET status = ?, result = COALESCE(?, result), updated_at = ? WHERE id = ?", [status, result ?? null, now(), id]);
  }

  // ---- Chat ----
  createConversation(title = "Nouvelle conversation"): Conversation {
    const t = now();
    const id = randomUUID();
    this.db.run("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?,?,?,?)", [id, title, t, t]);
    return { id, title, createdAt: t, updatedAt: t };
  }

  listConversations(): Conversation[] {
    return this.db
      .all<Row>("SELECT * FROM conversations WHERE deleted = 0 ORDER BY updated_at DESC LIMIT 200")
      .map((r) => ({ id: r.id as string, title: r.title as string, createdAt: r.created_at as string, updatedAt: r.updated_at as string }));
  }

  renameConversation(id: string, title: string): void {
    this.db.run("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?", [title, now(), id]);
  }

  deleteConversation(id: string): void {
    // Suppression « douce » : la ligne reste (deleted = 1) pour que la suppression se propage à l'autre appareil
    this.purgeMessages(id);
    this.db.run("UPDATE conversations SET deleted = 1, updated_at = ? WHERE id = ?", [now(), id]);
  }

  purgeMessages(conversationId: string): void {
    this.db.run("DELETE FROM messages WHERE conversation_id = ?", [conversationId]);
  }

  addMessage(conversationId: string, m: ChatMessage): ChatMessage {
    const t = now();
    const id = randomUUID();
    const seq = (this.db.all<Row>("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM messages WHERE conversation_id = ?", [conversationId])[0]?.n as number) ?? 1;
    const j = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
    this.db.run(
      `INSERT INTO messages (id, conversation_id, role, content, tool_calls, tool_call_id, tool_name, raw, cards, engine, seq, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, conversationId, m.role, m.content, j(m.toolCalls), m.toolCallId ?? null, m.toolName ?? null, j(m.raw), j(m.cards), m.engine ?? null, seq, t]
    );
    this.db.run("UPDATE conversations SET updated_at = ? WHERE id = ?", [t, conversationId]);
    return { ...m, id, conversationId, createdAt: t };
  }

  getMessages(conversationId: string): ChatMessage[] {
    const p = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : undefined);
    return this.db
      .all<Row>("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, seq", [conversationId])
      .map((r) => ({
        id: r.id as string,
        conversationId,
        role: r.role as ChatMessage["role"],
        content: r.content as string,
        toolCalls: p(r.tool_calls),
        toolCallId: (r.tool_call_id as string) ?? undefined,
        toolName: (r.tool_name as string) ?? undefined,
        raw: p(r.raw),
        cards: p(r.cards),
        engine: (r.engine as string) ?? undefined,
        createdAt: r.created_at as string,
      }));
  }

  /** Derniers brouillons validés par Robin : servent d'exemples de style (few-shot) */
  listApprovedExamples(limit = 3): { subject: string; body: string }[] {
    return this.db
      .all<Row>("SELECT subject, body_html FROM drafts WHERE status IN ('approved','sent') AND deleted = 0 ORDER BY updated_at DESC LIMIT ?", [limit])
      .map((r) => ({ subject: r.subject as string, body: htmlToPlain(r.body_html as string) }));
  }
}
