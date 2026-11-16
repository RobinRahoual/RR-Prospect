import { describe, expect, it } from "vitest";
import { Database, enqueueJob, processJobs, Repo, syncOnce, type JobRunners, type Remote, type RemoteDoc, type RemoteWrite } from "../index";

class FakeRemote implements Remote {
  docs = new Map<string, Map<string, RemoteDoc>>();
  n = 0;
  async commit(ws: RemoteWrite[]) {
    this.n++;
    for (const w of ws) {
      const col = this.docs.get(w.col) ?? new Map();
      this.docs.set(w.col, col);
      col.set(w.id, { id: w.id, u: w.u, j: w.j, p: `2030-01-01T00:00:00.${String(this.n).padStart(6, "0")}Z` });
    }
  }
  async pull(col: string, since: string | null, limit: number) {
    return [...(this.docs.get(col)?.values() ?? [])].filter((d) => !since || d.p >= since).sort((a, b) => a.p.localeCompare(b.p)).slice(0, limit);
  }
}
async function device() {
  const repo = new Repo(await Database.open());
  repo.migrate();
  return repo;
}
const runners = (log: string[] = []): JobRunners => ({
  scan: async (o) => (log.push(`scan ${JSON.stringify(o)}`), "3 nouveaux"),
  analyze: async (id) => (log.push(`analyze ${id}`), "ok"),
  send: async (id) => {
    log.push(`send ${id}`);
    throw new Error("Valide le brouillon avant de l'envoyer");
  },
  sendApproved: async () => (log.push("batch"), "2 envoyé(s)"),
});

describe("historique du chat synchronisé", () => {
  it("une conversation commencée sur l'iPad apparaît sur le PC avec ses messages dans l'ordre, sans doublon", async () => {
    const r = new FakeRemote();
    const pc = await device();
    const ipad = await device();
    const c = ipad.createConversation("Bonjour");
    ipad.addMessage(c.id, { role: "user", content: "Salut" });
    ipad.addMessage(c.id, { role: "assistant", content: "Hello", engine: "gemini" });
    await syncOnce(ipad, r);
    expect((await syncOnce(pc, r)).pulled).toBe(3);
    expect(pc.listConversations()[0]!.title).toBe("Bonjour");
    expect(pc.getMessages(c.id).map((m) => m.content)).toEqual(["Salut", "Hello"]);
    // rien de neuf : aucune écriture ni doublon
    const n = r.n;
    expect(await syncOnce(pc, r)).toMatchObject({ pushed: 0, pulled: 0 });
    await syncOnce(ipad, r);
    expect(r.n).toBe(n);
    // le PC répond dans la même conversation, l'iPad le voit
    pc.addMessage(c.id, { role: "user", content: "Et les leads ?" });
    await syncOnce(pc, r);
    await syncOnce(ipad, r);
    expect(ipad.getMessages(c.id).map((m) => m.content)).toEqual(["Salut", "Hello", "Et les leads ?"]);
  });

  it("supprimer une conversation la supprime partout et ne la ressuscite pas", async () => {
    const r = new FakeRemote();
    const pc = await device();
    const ipad = await device();
    const c = pc.createConversation("À jeter");
    pc.addMessage(c.id, { role: "user", content: "x" });
    await syncOnce(pc, r);
    await syncOnce(ipad, r);
    expect(ipad.listConversations()).toHaveLength(1);
    ipad.deleteConversation(c.id);
    await syncOnce(ipad, r);
    await syncOnce(pc, r);
    expect(pc.listConversations()).toHaveLength(0);
    expect(pc.getMessages(c.id)).toHaveLength(0);
    await syncOnce(ipad, r);
    await syncOnce(pc, r);
    expect(pc.listConversations()).toHaveLength(0);
    expect(ipad.listConversations()).toHaveLength(0);
  });

  it("un nouvel appareil récupère tout l'historique", async () => {
    const r = new FakeRemote();
    const pc = await device();
    for (let i = 0; i < 3; i++) {
      const c = pc.createConversation(`Conv ${i}`);
      pc.addMessage(c.id, { role: "user", content: `m${i}` });
    }
    await syncOnce(pc, r);
    const fresh = await device();
    await syncOnce(fresh, r);
    expect(fresh.listConversations()).toHaveLength(3);
  });
});

describe("commandes iPad → PC", () => {
  it("l'iPad demande, le PC exécute, le résultat revient sur l'iPad", async () => {
    const r = new FakeRemote();
    const pc = await device();
    const ipad = await device();
    const j = enqueueJob(ipad, "scan", { categories: ["bar"], radiusKm: 5 });
    await syncOnce(ipad, r);
    await syncOnce(pc, r, ["jobs"]);
    const log: string[] = [];
    expect(await processJobs(pc, runners(log))).toBe(1);
    expect(log).toEqual(['scan {"categories":["bar"],"radiusKm":5}']);
    await syncOnce(pc, r, ["jobs"]);
    await syncOnce(ipad, r);
    expect(ipad.getJob(j.id)).toMatchObject({ status: "done", result: "3 nouveaux" });
    // une commande terminée n'est jamais rejouée
    expect(await processJobs(pc, runners(log))).toBe(0);
  });

  it("un envoi refusé par les garde-fous du PC revient en échec avec la raison", async () => {
    const r = new FakeRemote();
    const pc = await device();
    const ipad = await device();
    const j = enqueueJob(ipad, "send", { draftId: "d1" });
    await syncOnce(ipad, r);
    await syncOnce(pc, r);
    await processJobs(pc, runners());
    await syncOnce(pc, r);
    await syncOnce(ipad, r);
    expect(ipad.getJob(j.id)).toMatchObject({ status: "error", result: "Valide le brouillon avant de l'envoyer" });
  });

  it("un double clic ne crée qu'une commande ; les paramètres sont validés", async () => {
    const ipad = await device();
    const a = enqueueJob(ipad, "send", { draftId: "d1" });
    const b = enqueueJob(ipad, "send", { draftId: "d1" });
    expect(b.id).toBe(a.id);
    expect(ipad.listJobs()).toHaveLength(1);
    expect(() => enqueueJob(ipad, "send", {})).toThrow();
    expect(() => enqueueJob(ipad, "analyze", { leadId: 12 })).toThrow();
    // @ts-expect-error commande inconnue
    expect(() => enqueueJob(ipad, "rm -rf", {})).toThrow();
    expect(enqueueJob(ipad, "scan", { radiusKm: 9999 }).params.radiusKm).toBe(50);
  });

  it("une commande d'envoi trop ancienne est abandonnée, jamais exécutée", async () => {
    const pc = await device();
    const j = enqueueJob(pc, "send", { draftId: "d1" });
    const log: string[] = [];
    const later = new Date(Date.parse(j.createdAt) + 13 * 3_600_000);
    await processJobs(pc, runners(log), { now: later });
    expect(log).toEqual([]);
    expect(pc.getJob(j.id)).toMatchObject({ status: "error" });
    expect(pc.getJob(j.id)!.result).toMatch(/Expirée/);
  });

  it("une commande restée « en cours » (app fermée) n'est jamais relancée toute seule", async () => {
    const pc = await device();
    const j = enqueueJob(pc, "send", { draftId: "d1" });
    pc.setJobStatus(j.id, "running");
    const log: string[] = [];
    expect(await processJobs(pc, runners(log))).toBe(0);
    expect(log).toEqual([]);
    expect(pc.getJob(j.id)).toMatchObject({ status: "error" });
  });

  it("un état ancien ne peut pas faire revenir une commande en arrière", async () => {
    const r = new FakeRemote();
    const pc = await device();
    const ipad = await device();
    const j = enqueueJob(ipad, "analyze", { leadId: "L" });
    await syncOnce(ipad, r);
    await syncOnce(pc, r);
    await processJobs(pc, runners());
    await syncOnce(pc, r);
    // l'iPad, resté sur « en attente », repousse sa copie avec une date plus récente
    const row = ipad.getRow("jobs", j.id)!;
    ipad.putRow("jobs", { ...row, updated_at: "2099-01-01T00:00:00.000Z" });
    await syncOnce(ipad, r);
    expect(ipad.getJob(j.id)!.status).toBe("done");
    await syncOnce(pc, r);
    expect(pc.getJob(j.id)!.status).toBe("done");
    expect(await processJobs(pc, runners())).toBe(0);
  });
});
