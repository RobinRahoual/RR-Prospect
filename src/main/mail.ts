import nodemailer from "nodemailer";
import type { Transport } from "../core";

/** Envoi via le SMTP de Gmail avec un mot de passe d'application (Gmail enregistre le message dans « Envoyés »). */
export function gmailTransport(user: string, pass: string): Transport {
  const t = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass: pass.replace(/\s+/g, "") },
    connectionTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return {
    async send(m) {
      const r = await t.sendMail({ from: m.from, to: m.to, subject: m.subject, html: m.html, text: m.text, headers: m.headers });
      return { messageId: r.messageId };
    },
  };
}
