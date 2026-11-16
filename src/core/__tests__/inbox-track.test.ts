import { describe, expect, it } from "vitest";
import {
  buildMessage, classify, Database, DEFAULT_MAIL, deployTracker, executeTool, processInbox, Repo, sendDraft, senderFilter, topOfReply, Tracker, WORKER_JS,
  type InboundMail,
} from "../index";

const S = { ...DEFAULT_MAIL, address: "robin@gmail.com", dailyCap: 10 };
const mail = (o: Partial<InboundMail>): InboundMail => ({ messageId: "m" + Math.random(), from: "bar@zinc.fr", subject: "Re: Sujet", text: "Oui intéressé", date: "2026-11-17T10:00:00Z", ...o });
async function mk() {
  const repo = new Repo(await Database.open());
  repo.migrate();
  const lead = repo.createLead({ name: "Zinc", email: "bar@zinc.fr" });
  repo.setLeadStatus(lead.id, "sent");
  return { repo, lead };
}

describe("classification des mails reçus", () => {
  it("détecte réponse, STOP (hors citation), rebond, réponse automatique", () => {
    expect(classify(mail({}))).toBe("reply");
    expect(classify(mail({ text: "STOP" }))).toBe("stop");
    expect(classify(mail({ text: "Merci de ne plus me contacter." }))).toBe("stop");
    expect(classify(mail({ subject: "STOP" }))).toBe("stop");
    // « stop » dans la citation du message d'origine : pas un STOP
    expect(classify(mail({ text: "Pourquoi pas, appelez-moi.\n\nLe 16 nov. 2026 à 15:00, Robin a écrit :\n> répondez STOP pour ne plus recevoir" }))).toBe("reply");
    expect(classify(mail({ from: "mailer-daemon@googlemail.com", subject: "Delivery Status Notification (Failure)" }))).toBe("bounce");
    expect(classify(mail({ subject: "Réponse automatique : absent" }))).toBe("ignore");
    expect(classify(mail({ autoSubmitted: true }))).toBe("ignore");
    expect(topOfReply("Salut\n> cité")).toBe("Salut");
  });
});

describe("traitement de la boîte", () => {
  it("réponse → replied ; STOP → suppression ; rebond → suppression ; idempotent ; inconnus ignorés", async () => {
    const { repo, lead } = await mk();
    const r = processInbox(repo, [mail({ messageId: "a" })]);
    expect(r.replies).toBe(1);
    expect(repo.getLead(lead.id)!.status).toBe("replied");
    expect(processInbox(repo, [mail({ messageId: "a" })]).replies).toBe(0); // déjà vu

    const b = await mk();
    expect(processInbox(b.repo, [mail({ messageId: "s", text: "STOP" })]).stops).toBe(1);
    expect(b.repo.isSuppressed("bar@zinc.fr")).toBe(true);
    expect(b.repo.getLead(b.lead.id)!.status).toBe("skipped");

    const c = await mk();
    const bo = processInbox(c.repo, [mail({ messageId: "b", from: "mailer-daemon@googlemail.com", subject: "Delivery Status Notification (Failure)", text: "Le message n'a pas pu être remis à bar@zinc.fr", failedRecipients: [] })]);
    expect(bo.bounces).toBe(1);
    expect(c.repo.isSuppressed("bar@zinc.fr")).toBe(true);

    const d = await mk();
    expect(processInbox(d.repo, [mail({ messageId: "x", from: "inconnu@autre.fr" })]).replies).toBe(0);
    expect(d.repo.listInbound()).toHaveLength(0);
  });
  it("filtre d'expéditeurs : lead contacté, domaine pro, rebond ; pas les domaines gratuits entiers", async () => {
    const { repo } = await mk();
    repo.createLead({ name: "Gmailer", email: "x@gmail.com" });
    const l2 = repo.listLeads().find((l) => l.name === "Gmailer")!;
    repo.setLeadStatus(l2.id, "sent");
    const f = senderFilter(repo.listLeads());
    expect(f("bar@zinc.fr")).toBe(true);
    expect(f("autre@zinc.fr")).toBe(true);
    expect(f("mailer-daemon@googlemail.com")).toBe(true);
    expect(f("x@gmail.com")).toBe(true);
    expect(f("random@gmail.com")).toBe(false);
  });
});

describe("pixel de suivi", () => {
  it("le message contient pixel + mention ; sans pixel, rien", () => {
    const m = buildMessage(S, "a@b.fr", "S", "<p>x</p>", "https://w.dev/o/abc.gif");
    expect(m.html).toContain('<img src="https://w.dev/o/abc.gif"');
    expect(m.html).toContain("pixel de mesure");
    expect(m.text).toContain("pixel de mesure");
    expect(buildMessage(S, "a@b.fr", "S", "<p>x</p>").html).not.toContain("<img");
  });
  it("sendDraft enregistre l'id de suivi ; Worker injoignable → envoi sans pixel", async () => {
    const { repo, lead } = await mk();
    repo.setLeadStatus(lead.id, "drafted");
    const d = repo.addDraft(lead.id, { subject: "s", bodyHtml: "<p>x</p>", hookUsed: "", confidence: 1 }, "t");
    repo.updateDraft(d.id, { status: "approved" });
    const htmls: string[] = [];
    const t = { send: async (m: { html: string }) => (htmls.push(m.html), { messageId: "id" }) };
    const calls: string[] = [];
    const ok = new Tracker("https://w.dev", "sec", (async (u: string) => (calls.push(u), { ok: true, json: async () => ({}) })) as any);
    expect((await sendDraft(repo, t, S, d.id, { tracker: ok })).ok).toBe(true);
    expect(htmls[0]).toContain("https://w.dev/o/");
    expect(repo.listTrackIds()).toHaveLength(1);
    expect(calls[0]).toBe("https://w.dev/api/register");

    const l2 = repo.createLead({ name: "B", email: "b@b.fr" });
    const d2 = repo.addDraft(l2.id, { subject: "s", bodyHtml: "<p>x</p>", hookUsed: "", confidence: 1 }, "t");
    repo.updateDraft(d2.id, { status: "approved" });
    const down = new Tracker("https://w.dev", "sec", (async () => { throw new Error("offline"); }) as any);
    expect((await sendDraft(repo, t, S, d2.id, { tracker: down })).ok).toBe(true);
    expect(htmls[1]).not.toContain("<img");
  });
  it("ouvertures, relances et outil get_activity", async () => {
    const { repo, lead } = await mk();
    repo.recordSend({ draftId: "d", leadId: lead.id, to: "bar@zinc.fr", subject: "s", messageId: "m", status: "sent", trackId: "t1" });
    repo.setOpens("t1", 3, 1000, 2000);
    expect(repo.opensByLead()[lead.id]!.opens).toBe(3);
    expect(repo.followUps(0)).toHaveLength(1);
    expect(repo.followUps(4)).toHaveLength(0); // envoyé à l'instant
    const out = await executeTool({ repo, generateDraft: async () => ({ draft: { subject: "", bodyHtml: "", hookUsed: "", confidence: 0 }, engine: "t" }) }, { id: "1", name: "get_activity", args: {} });
    expect((out.result as any).ouvertsSansRéponse[0]).toMatchObject({ lead: "Zinc", ouvertures: 3 });
  });
});

describe("Worker Cloudflare", () => {
  // Exécute le vrai code du Worker avec un faux KV
  async function load() {
    const mod = await import(`data:text/javascript;base64,${Buffer.from(WORKER_JS).toString("base64")}`);
    const store = new Map<string, string>();
    const env = {
      SECRET: "s3cret",
      KV: { get: async (k: string) => (store.has(k) ? JSON.parse(store.get(k)!) : null), put: async (k: string, v: string) => void store.set(k, v) },
    };
    return { w: mod.default as { fetch: (r: Request, e: unknown) => Promise<Response> }, env, store };
  }
  const post = (path: string, body: unknown, key = "s3cret") =>
    new Request("https://w.dev" + path, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(body) });

  it("enregistre, ignore les ouvertures < 15 s, compte ensuite, refuse sans secret", async () => {
    const { w, env, store } = await load();
    expect((await w.fetch(post("/api/register", { id: "abcdefgh-1" }, "mauvais"), env)).status).toBe(401);
    expect((await w.fetch(post("/api/register", { id: "abcdefgh-1" }), env)).status).toBe(200);
    const px = () => w.fetch(new Request("https://w.dev/o/abcdefgh-1.gif"), env);
    const r1 = await px();
    expect(r1.headers.get("content-type")).toBe("image/gif");
    let stats = await (await w.fetch(post("/api/stats", { ids: ["abcdefgh-1"] }), env)).json();
    expect(stats["abcdefgh-1"].opens).toBe(0); // trop tôt : scanner antivirus
    const rec = JSON.parse(store.get("o:abcdefgh-1")!);
    store.set("o:abcdefgh-1", JSON.stringify({ ...rec, created: Date.now() - 60_000 }));
    await px();
    await px();
    stats = await (await w.fetch(post("/api/stats", { ids: ["abcdefgh-1", "inconnu123"] }), env)).json();
    expect(stats["abcdefgh-1"].opens).toBe(2);
    expect(stats["inconnu123"]).toBeUndefined();
    // id jamais enregistré : le pixel répond mais ne crée rien
    await w.fetch(new Request("https://w.dev/o/zzzzzzzz-9.gif"), env);
    expect(store.has("o:zzzzzzzz-9")).toBe(false);
    expect((await w.fetch(new Request("https://w.dev/health"), env)).status).toBe(200);
  });
});

describe("déploiement Cloudflare", () => {
  it("enchaîne compte → KV → script → sous-domaine → vérification, avec les bons liens", async () => {
    const calls: string[] = [];
    let bodyMeta = "";
    const f = (async (url: string, init: any) => {
      const u = String(url);
      calls.push(`${init?.method ?? "GET"} ${u.replace("https://api.cloudflare.com/client/v4", "")}`);
      const ok = (result: unknown) => ({ ok: true, status: 200, json: async () => ({ success: true, result }), text: async () => "ok" });
      if (u.endsWith("/accounts")) return ok([{ id: "ACC", name: "x" }]);
      if (u.includes("/kv/namespaces?")) return ok([]);
      if (u.endsWith("/kv/namespaces")) return ok({ id: "NS1" });
      if (u.includes("/workers/scripts/rr-prospect-track") && init.method === "PUT") {
        bodyMeta = await (init.body.get("metadata") as Blob).text();
        return ok({});
      }
      if (u.endsWith("/workers/subdomain") && (init?.method ?? "GET") === "GET") return ok({ subdomain: "robin" });
      if (u.endsWith("/subdomain")) return ok({});
      if (u.endsWith("/health")) return ok(null);
      throw new Error("inattendu " + u);
    }) as any;
    const r = await deployTracker({ token: "tok", secret: "S" }, f, undefined, async () => undefined);
    expect(r).toEqual({ url: "https://rr-prospect-track.robin.workers.dev", accountId: "ACC" });
    expect(JSON.parse(bodyMeta).bindings).toEqual([
      { type: "kv_namespace", name: "KV", namespace_id: "NS1" },
      { type: "secret_text", name: "SECRET", text: "S" },
    ]);
    expect(calls[0]).toBe("GET /accounts");
  });
  it("jeton refusé : message clair", async () => {
    const f = (async () => ({ ok: false, status: 403, json: async () => ({ success: false, errors: [{ message: "denied" }] }) })) as any;
    await expect(deployTracker({ token: "x", secret: "s" }, f)).rejects.toThrow(/Edit Cloudflare Workers/);
  });
});
