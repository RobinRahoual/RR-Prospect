import { describe, expect, it } from "vitest";
import { buildMessage, Database, DEFAULT_MAIL, isEmail, mailStatus, normalizeMail, Repo, sendBatch, sendDraft, type Transport } from "../index";

const S = { ...DEFAULT_MAIL, address: "robin@gmail.com", dailyCap: 2 };
async function setup(email: string | null = "bar@zinc.fr") {
  const repo = new Repo(await Database.open());
  repo.migrate();
  const lead = repo.createLead({ name: "Zinc", email });
  const draft = repo.addDraft(lead.id, { subject: "Sujet", bodyHtml: "<p>Bonjour</p>", hookUsed: "", confidence: 1 }, "t");
  return { repo, lead, draft };
}
const okT = (log: string[] = []): Transport => ({ send: async (m) => (log.push(m.to), { messageId: `<${log.length}@x>` }) });

describe("message", () => {
  it("ajoute signature, mention STOP et en-tête List-Unsubscribe ; échappe la signature", () => {
    const m = buildMessage({ ...S, signature: "<b>R</b>\nDijon" }, "a@b.fr", "Hello\r\nBcc: x@y.z", "<p>Corps</p>");
    expect(m.html).toContain("&lt;b&gt;R&lt;/b&gt;<br>Dijon");
    expect(m.html).toContain("STOP");
    expect(m.text).toContain("Corps");
    expect(m.headers["List-Unsubscribe"]).toBe("<mailto:robin@gmail.com?subject=STOP>");
    expect(m.subject).not.toMatch(/[\r\n]/);
  });
  it("valide les réglages", () => {
    expect(() => normalizeMail({ address: "pas un mail" })).toThrow(/invalide/);
    expect(normalizeMail({ dailyCap: 999 }).dailyCap).toBe(40);
    expect(isEmail("a@b.fr")).toBe(true);
    expect(isEmail("a@b")).toBe(false);
  });
});

describe("sendDraft : garde-fous", () => {
  it("refuse un brouillon non validé, puis envoie un validé et met à jour les statuts", async () => {
    const { repo, lead, draft } = await setup();
    const log: string[] = [];
    expect(await sendDraft(repo, okT(log), S, draft.id)).toMatchObject({ ok: false, error: expect.stringMatching(/Valide/) });
    repo.updateDraft(draft.id, { status: "approved" });
    expect(await sendDraft(repo, okT(log), S, draft.id)).toMatchObject({ ok: true, to: "bar@zinc.fr" });
    expect(repo.getLead(lead.id)!.status).toBe("sent");
    expect(repo.getDraft(draft.id)!.status).toBe("sent");
    expect(mailStatus(repo, S).sentToday).toBe(1);
    expect(await sendDraft(repo, okT(log), S, draft.id)).toMatchObject({ ok: false });
    expect(log).toEqual(["bar@zinc.fr"]);
  });
  it("bloque désinscrit, sans email, et adresse d'envoi manquante", async () => {
    const a = await setup();
    a.repo.updateDraft(a.draft.id, { status: "approved" });
    a.repo.addSuppression("BAR@zinc.fr");
    expect(await sendDraft(a.repo, okT(), S, a.draft.id)).toMatchObject({ error: expect.stringMatching(/désinscrit/) });
    const b = await setup(null);
    b.repo.updateDraft(b.draft.id, { status: "approved" });
    expect(await sendDraft(b.repo, okT(), S, b.draft.id)).toMatchObject({ error: expect.stringMatching(/email valide/) });
    const c = await setup();
    c.repo.updateDraft(c.draft.id, { status: "approved" });
    expect(await sendDraft(c.repo, okT(), { ...S, address: "" }, c.draft.id)).toMatchObject({ error: expect.stringMatching(/Gmail/) });
  });
  it("respecte le plafond quotidien", async () => {
    const { repo } = await setup();
    for (let i = 0; i < 2; i++) repo.recordSend({ draftId: "d", leadId: "l", to: "x@y.fr", subject: "s", messageId: "m", status: "sent" });
    const l = repo.createLead({ name: "Autre", email: "o@o.fr" });
    const d = repo.addDraft(l.id, { subject: "s", bodyHtml: "<p>x</p>", hookUsed: "", confidence: 1 }, "t");
    repo.updateDraft(d.id, { status: "approved" });
    expect(await sendDraft(repo, okT(), S, d.id)).toMatchObject({ error: expect.stringMatching(/Plafond/) });
  });
  it("échec d'envoi : journalisé, brouillon non marqué envoyé, message clair", async () => {
    const { repo, lead, draft } = await setup();
    repo.updateDraft(draft.id, { status: "approved" });
    const bad: Transport = { send: async () => { throw new Error("535 Invalid login"); } };
    const r = await sendDraft(repo, bad, S, draft.id);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/mot de passe d'application/) });
    expect(repo.getDraft(draft.id)!.status).toBe("approved");
    expect(repo.getLead(lead.id)!.status).toBe("drafted");
    expect(mailStatus(repo, S).sentToday).toBe(0);
  });
});

describe("sendBatch", () => {
  it("envoie un par un avec pause, s'arrête au plafond, et sait être interrompu", async () => {
    const { repo } = await setup();
    repo.updateDraft(repo.listLeads()[0] ? repo.listDrafts(repo.listLeads()[0]!.id)[0]!.id : "", { status: "approved" });
    for (const n of ["B", "C"]) {
      const l = repo.createLead({ name: n, email: `${n}@x.fr` });
      const d = repo.addDraft(l.id, { subject: "s", bodyHtml: "<p>x</p>", hookUsed: "", confidence: 1 }, "t");
      repo.updateDraft(d.id, { status: "approved" });
    }
    const waits: number[] = [];
    const r = await sendBatch(repo, okT(), S, { sleep: async (ms) => void waits.push(ms), delayRange: [2, 2] });
    expect(r).toMatchObject({ sent: 2, stopped: true }); // plafond de 2 → le 3e est refusé et l'on s'arrête
    expect(waits.length).toBe(4); // 2 pauses de 2 s
    for (const n2 of ["D", "E"]) {
      const l = repo.createLead({ name: n2, email: `${n2}@x.fr` });
      const d = repo.addDraft(l.id, { subject: "s", bodyHtml: "<p>x</p>", hookUsed: "", confidence: 1 }, "t");
      repo.updateDraft(d.id, { status: "approved" });
    }
    let n = 0;
    const r2 = await sendBatch(repo, okT(), { ...S, dailyCap: 40 }, { sleep: async () => undefined, shouldStop: () => n++ > 0 });
    expect(r2.stopped).toBe(true);
  });
});
