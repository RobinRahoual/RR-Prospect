import type { Repo } from "../repo";
import { htmlToPlain } from "../chat/tools";

export interface MailSettings {
  address: string; // adresse Gmail d'envoi
  fromName: string;
  signature: string; // texte, une ligne par <br>
  dailyCap: number;
}

export const DEFAULT_MAIL: MailSettings = {
  address: "",
  fromName: "Robin Rahoual",
  signature: "Robin Rahoual\nVidéaste & photographe — Dijon\nrobinrahoual.fr",
  dailyCap: 25,
};

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
}
export interface Transport {
  send(m: MailMessage): Promise<{ messageId: string }>;
}

const EMAIL_RE = /^[^\s@<>()]+@[^\s@<>()]+\.[A-Za-z]{2,}$/;
export const isEmail = (s: string | null | undefined): s is string => !!s && EMAIL_RE.test(s.trim());
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function normalizeMail(input: Partial<MailSettings> | undefined, base: MailSettings = DEFAULT_MAIL): MailSettings {
  const s = { ...base, ...(input ?? {}) };
  if (s.address && !isEmail(s.address)) throw new Error("Adresse email d'envoi invalide");
  return {
    address: (s.address ?? "").trim(),
    fromName: (s.fromName ?? "").trim().slice(0, 80) || "Robin Rahoual",
    signature: (s.signature ?? "").slice(0, 600),
    dailyCap: Math.round(Math.min(40, Math.max(1, Number(s.dailyCap) || base.dailyCap))),
  };
}

/** Corps + signature + mention de désinscription (obligatoire en prospection B2B). */
export function buildMessage(s: MailSettings, to: string, subject: string, bodyHtml: string): MailMessage {
  const sig = esc(s.signature).replace(/\n/g, "<br>");
  const stop = "Si vous ne souhaitez plus recevoir de message de ma part, répondez simplement « STOP » : je ne vous écrirai plus.";
  const html = `${bodyHtml}<p>${sig}</p><p style="color:#777;font-size:12px">${esc(stop)}</p>`;
  return {
    from: `"${s.fromName.replace(/"/g, "")}" <${s.address}>`,
    to,
    subject: subject.replace(/[\r\n]+/g, " ").trim(),
    html,
    text: `${htmlToPlain(bodyHtml)}\n\n${s.signature}\n\n${stop}`,
    headers: { "List-Unsubscribe": `<mailto:${s.address}?subject=STOP>` },
  };
}

const startOfToday = (now: Date) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

export function mailStatus(repo: Repo, s: MailSettings, now = new Date()) {
  return { configured: !!s.address, sentToday: repo.countSentSince(startOfToday(now)), cap: s.dailyCap };
}

export type SendResult = { ok: true; to: string; messageId: string } | { ok: false; error: string };

/** Garde-fous : brouillon validé, email valide, pas de désinscrit, pas de doublon, plafond du jour. */
export async function sendDraft(
  repo: Repo,
  t: Transport,
  s: MailSettings,
  draftId: string,
  o: { now?: Date; toOverride?: string } = {}
): Promise<SendResult> {
  const now = o.now ?? new Date();
  const draft = repo.getDraft(draftId);
  if (!draft) return { ok: false, error: "Brouillon introuvable" };
  const lead = repo.getLead(draft.leadId);
  if (!lead) return { ok: false, error: "Lead introuvable" };
  if (!isEmail(s.address)) return { ok: false, error: "Configure ton adresse Gmail dans Réglages" };
  if (draft.status === "sent") return { ok: false, error: "Ce brouillon a déjà été envoyé" };
  if (draft.status !== "approved") return { ok: false, error: "Valide le brouillon avant de l'envoyer" };
  const to = (o.toOverride ?? lead.email)?.trim();
  if (!isEmail(to)) return { ok: false, error: "Ce lead n'a pas d'adresse email valide" };
  if (repo.isSuppressed(to)) return { ok: false, error: "Contact désinscrit : envoi bloqué" };
  if (lead.status === "sent" || lead.status === "replied") return { ok: false, error: "Ce lead a déjà été contacté" };
  const st = mailStatus(repo, s, now);
  if (st.sentToday >= st.cap) return { ok: false, error: `Plafond du jour atteint (${st.cap} envois)` };

  const msg = buildMessage(s, to, draft.subject, draft.bodyHtml);
  try {
    const r = await t.send(msg);
    repo.recordSend({ draftId: draft.id, leadId: lead.id, to, subject: draft.subject, messageId: r.messageId, status: "sent" });
    repo.updateDraft(draft.id, { status: "sent" });
    repo.setLeadStatus(lead.id, "sent");
    return { ok: true, to, messageId: r.messageId };
  } catch (e) {
    const error = (e as Error).message;
    repo.recordSend({ draftId: draft.id, leadId: lead.id, to, subject: draft.subject, messageId: null, status: "failed", error });
    return { ok: false, error: friendlyMailError(error) };
  }
}

export function friendlyMailError(m: string): string {
  if (/535|Invalid login|Username and Password not accepted/i.test(m)) return "Gmail refuse le mot de passe d'application (régénère-le dans ton compte Google).";
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN/i.test(m)) return "Connexion à Gmail impossible : vérifie ta connexion internet.";
  if (/550|5\.1\.1|does not exist/i.test(m)) return "Adresse destinataire refusée par le serveur (inexistante ?).";
  return m;
}

export interface BatchProgress {
  index: number;
  total: number;
  lead: string;
  result?: SendResult;
  waitSec?: number;
}

/** Envoie les brouillons validés un par un, avec une pause aléatoire entre chaque (anti-spam). */
export async function sendBatch(
  repo: Repo,
  t: Transport,
  s: MailSettings,
  o: {
    onProgress?: (p: BatchProgress) => void;
    sleep?: (ms: number) => Promise<void>;
    shouldStop?: () => boolean;
    delayRange?: [number, number];
    now?: () => Date;
  } = {}
): Promise<{ sent: number; failed: number; stopped: boolean }> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const [lo, hi] = o.delayRange ?? [90, 240];
  const queue = repo
    .listLeads()
    .flatMap((l) => repo.listDrafts(l.id).filter((d) => d.status === "approved").slice(0, 1).map((d) => ({ d, l })))
    .filter(({ l }) => isEmail(l.email) && !repo.isSuppressed(l.email!) && l.status !== "sent" && l.status !== "replied");
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < queue.length; i++) {
    if (o.shouldStop?.()) return { sent, failed, stopped: true };
    const { d, l } = queue[i]!;
    const result = await sendDraft(repo, t, s, d.id, { now: o.now?.() });
    o.onProgress?.({ index: i + 1, total: queue.length, lead: l.name, result });
    if (result.ok) sent++;
    else {
      failed++;
      if (/Plafond|Gmail refuse|Connexion à Gmail|Configure/.test(result.error)) return { sent, failed, stopped: true }; // inutile d'insister
    }
    if (i + 1 < queue.length) {
      const wait = Math.round(lo + Math.random() * (hi - lo));
      o.onProgress?.({ index: i + 1, total: queue.length, lead: l.name, waitSec: wait });
      for (let s2 = 0; s2 < wait; s2++) {
        if (o.shouldStop?.()) return { sent, failed, stopped: true };
        await sleep(1000);
      }
    }
  }
  return { sent, failed, stopped: false };
}
