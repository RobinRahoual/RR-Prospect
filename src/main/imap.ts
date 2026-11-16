import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { InboundMail } from "../core";

const addr = (v: unknown): string => String((v as { value?: { address?: string }[] } | undefined)?.value?.[0]?.address ?? "").toLowerCase();

/**
 * Lit la boîte Gmail (IMAP, même mot de passe d'application) depuis `since`.
 * Pour limiter le volume, seuls les messages d'expéditeurs « utiles » sont téléchargés en entier.
 */
export async function fetchInbound(
  user: string,
  pass: string,
  since: Date,
  interesting: (from: string) => boolean
): Promise<InboundMail[]> {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass: pass.replace(/\s+/g, "") },
    logger: false,
    socketTimeout: 45_000,
  });
  const out: InboundMail[] = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = ((await client.search({ since })) || []).slice(-300);
      const wanted: number[] = [];
      for await (const msg of client.fetch(uids, { envelope: true, uid: true }, { uid: true })) {
        const from = (msg.envelope?.from?.[0]?.address ?? "").toLowerCase();
        if (from && interesting(from)) wanted.push(msg.uid);
      }
      for (const uid of wanted) {
        const dl = await client.download(String(uid), undefined, { uid: true });
        if (!dl.content) continue;
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of dl.content) {
          size += (c as Buffer).length;
          if (size > 400_000) break; // inutile de lire une pièce jointe de 20 Mo
          chunks.push(c as Buffer);
        }
        const p = await simpleParser(Buffer.concat(chunks));
        const failed = String(p.headers.get("x-failed-recipients") ?? "")
          .split(/[,;\s]+/)
          .filter(Boolean);
        out.push({
          messageId: p.messageId ?? `uid:${uid}`,
          from: addr(p.from),
          subject: p.subject ?? "",
          text: p.text ?? "",
          date: (p.date ?? new Date()).toISOString(),
          autoSubmitted: /auto-(replied|generated)/i.test(String(p.headers.get("auto-submitted") ?? "")),
          failedRecipients: failed,
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
  return out;
}
