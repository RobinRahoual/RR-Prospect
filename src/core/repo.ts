import { randomUUID } from "node:crypto";
import type { Database } from "./db";
import type { Draft, DraftOut, DraftStatus, Lead, LeadInput, LeadStatus } from "./types";

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
    `);
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
}
