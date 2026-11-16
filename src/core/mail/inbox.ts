import type { Lead } from "../types";
import type { Repo } from "../repo";
import { isEmail } from "./mailer";

export interface InboundMail {
  messageId: string;
  from: string; // adresse seule, minuscules
  subject: string;
  text: string;
  date: string; // ISO
  autoSubmitted?: boolean;
  failedRecipients?: string[];
}

export type InboundKind = "reply" | "stop" | "bounce" | "ignore";

const FREE = new Set(["gmail.com", "googlemail.com", "outlook.com", "outlook.fr", "hotmail.com", "hotmail.fr", "live.com", "live.fr", "yahoo.com", "yahoo.fr", "orange.fr", "wanadoo.fr", "free.fr", "sfr.fr", "laposte.net", "icloud.com", "me.com", "proton.me", "protonmail.com"]);
const STOP_RE = /(^|[^a-zàâçéèêëîïôûùüÿñæœ])(stop|d[ée]sinscri\w*|d[ée]sabonn\w*|ne\s+plus\s+(?:me\s+)?(?:recevoir|[ée]crire|contacter|envoyer)|retir(?:ez|er)[- ]moi|supprim(?:ez|er)[- ]moi|ne\s+me\s+(?:contactez|[ée]crivez)\s+plus|unsubscribe)([^a-zàâçéèêëîïôûùüÿñæœ]|$)/i;
const AUTO_RE = /(r[ée]ponse automatique|out of office|absence du bureau|absent(?:e)? du bureau|automatic reply|auto[- ]?reply|accus[ée] de r[ée]ception automatique)/i;
const BOUNCE_FROM = /(mailer-daemon|postmaster|mail delivery)/i;
const BOUNCE_SUBJ = /(delivery status notification|undeliverable|undelivered|non remis|[ée]chec de (?:la )?livraison|failure notice|returned mail|delivery failure)/i;

/** Garde seulement ce que l'expéditeur a écrit : coupe à la première citation du message d'origine. */
export function topOfReply(text: string): string {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (const l of lines) {
    if (/^\s*>/.test(l) || /^(le .{5,80} a [ée]crit|on .{5,80} wrote)\s*:?\s*$/i.test(l.trim()) || /^-{2,}\s*(message d'origine|original message)/i.test(l.trim())) break;
    out.push(l);
  }
  return out.join("\n").trim().slice(0, 600);
}

export function classify(m: InboundMail): InboundKind {
  if (BOUNCE_FROM.test(m.from) || BOUNCE_SUBJ.test(m.subject)) return "bounce";
  if (m.autoSubmitted || AUTO_RE.test(m.subject)) return "ignore";
  const top = topOfReply(m.text);
  if (STOP_RE.test(m.subject) && m.subject.length < 40) return "stop";
  if (STOP_RE.test(top.slice(0, 300))) return "stop";
  return "reply";
}

function matchLead(leads: Lead[], m: InboundMail, kind: InboundKind): Lead | null {
  const sent = leads.filter((l) => l.email && (l.status === "sent" || l.status === "replied" || l.status === "drafted"));
  if (kind === "bounce") {
    const cands = new Set<string>((m.failedRecipients ?? []).map((e) => e.toLowerCase()));
    for (const e of m.text.toLowerCase().match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/g) ?? []) cands.add(e);
    return sent.find((l) => cands.has(l.email!.toLowerCase())) ?? null;
  }
  const exact = sent.find((l) => l.email!.toLowerCase() === m.from);
  if (exact) return exact;
  const dom = m.from.split("@")[1];
  if (!dom || FREE.has(dom)) return null;
  const same = sent.filter((l) => l.email!.toLowerCase().endsWith(`@${dom}`));
  return same.length === 1 ? same[0]! : null;
}

/** Filtre rapide avant téléchargement : expéditeur connu (lead contacté), même domaine pro, ou robot de rebond. */
export function senderFilter(leads: Lead[]): (from: string) => boolean {
  const emails = new Set<string>();
  const domains = new Set<string>();
  for (const l of leads) {
    if (!l.email || !["sent", "replied", "drafted"].includes(l.status)) continue;
    const e = l.email.toLowerCase();
    emails.add(e);
    const d = e.split("@")[1];
    if (d && !FREE.has(d)) domains.add(d);
  }
  return (from) => BOUNCE_FROM.test(from) || emails.has(from) || domains.has(from.split("@")[1] ?? "");
}

export interface InboxReport {
  replies: number;
  stops: number;
  bounces: number;
  checked: number;
  items: { leadName: string; kind: InboundKind; subject: string }[];
}

/** Traite des messages entrants : réponses → statut « replied », STOP/bounce → liste de suppression. */
export function processInbox(repo: Repo, mails: InboundMail[]): InboxReport {
  const rep: InboxReport = { replies: 0, stops: 0, bounces: 0, checked: mails.length, items: [] };
  for (const m of mails) {
    if (!m.messageId || repo.hasInbound(m.messageId)) continue;
    const kind = classify(m);
    const lead = kind === "ignore" && !m.from ? null : matchLead(repo.listLeads(), m, kind);
    if (!lead) {
      repo.recordInbound({ messageId: m.messageId, leadId: null, kind: "ignore", from: m.from, subject: m.subject, snippet: "", date: m.date });
      continue;
    }
    const snippet = topOfReply(m.text).slice(0, 280);
    repo.recordInbound({ messageId: m.messageId, leadId: lead.id, kind, from: m.from, subject: m.subject, snippet, date: m.date });
    if (kind === "ignore") continue;
    if (kind === "stop") {
      if (isEmail(lead.email)) repo.addSuppression(lead.email, "demande STOP reçue");
      if (isEmail(m.from)) repo.addSuppression(m.from, "demande STOP reçue");
      repo.setLeadStatus(lead.id, "skipped");
      rep.stops++;
    } else if (kind === "bounce") {
      if (isEmail(lead.email)) repo.addSuppression(lead.email, "adresse invalide (rebond)");
      repo.setLeadStatus(lead.id, "skipped");
      rep.bounces++;
    } else {
      repo.setLeadStatus(lead.id, "replied");
      rep.replies++;
    }
    rep.items.push({ leadName: lead.name, kind, subject: m.subject });
  }
  return rep;
}
