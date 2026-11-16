import { randomUUID } from "node:crypto";
import type { Database } from "./db";
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
      CREATE TABLE IF NOT EXISTS sends (
        id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, lead_id TEXT NOT NULL, to_email TEXT NOT NULL,
        subject TEXT NOT NULL, message_id TEXT, status TEXT NOT NULL, error TEXT, sent_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sends_at ON sends(sent_at);
      CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, seq);
    `);
    this.addColumn("leads", "analyzed_at", "TEXT");
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
  recordSend(r: { draftId: string; leadId: string; to: string; subject: string; messageId: string | null; status: "sent" | "failed"; error?: string }): void {
    this.db.run(
      "INSERT INTO sends (id, draft_id, lead_id, to_email, subject, message_id, status, error, sent_at) VALUES (?,?,?,?,?,?,?,?,?)",
      [randomUUID(), r.draftId, r.leadId, r.to, r.subject, r.messageId, r.status, r.error ?? null, now()]
    );
  }

  countSentSince(iso: string): number {
    return Number(this.db.all<Row>("SELECT COUNT(*) AS n FROM sends WHERE status = 'sent' AND sent_at >= ?", [iso])[0]?.n ?? 0);
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
      .all<Row>("SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 200")
      .map((r) => ({ id: r.id as string, title: r.title as string, createdAt: r.created_at as string, updatedAt: r.updated_at as string }));
  }

  renameConversation(id: string, title: string): void {
    this.db.run("UPDATE conversations SET title = ? WHERE id = ?", [title, id]);
  }

  deleteConversation(id: string): void {
    this.db.run("DELETE FROM messages WHERE conversation_id = ?", [id]);
    this.db.run("DELETE FROM conversations WHERE id = ?", [id]);
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
      .all<Row>("SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq", [conversationId])
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
