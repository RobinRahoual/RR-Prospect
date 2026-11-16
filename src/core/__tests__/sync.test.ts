import { describe, expect, it } from "vitest";
import { Database, FirebaseAuth, FirestoreRemote, mergeRows, Repo, syncOnce, type Remote, type RemoteDoc, type RemoteWrite } from "../index";

class FakeRemote implements Remote {
  docs = new Map<string, Map<string, RemoteDoc>>();
  n = 0;
  writes = 0;
  async commit(ws: RemoteWrite[]) {
    this.n++;
    for (const w of ws) {
      const col = this.docs.get(w.col) ?? new Map();
      this.docs.set(w.col, col);
      col.set(w.id, { id: w.id, u: w.u, j: w.j, p: `2030-01-01T00:00:00.${String(this.n).padStart(6, "0")}Z` });
      this.writes++;
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
const draftOut = { subject: "S", bodyHtml: "<p>x</p>", hookUsed: "", confidence: 1 };

describe("synchronisation PC ⇄ iPad", () => {
  it("propage leads, brouillons et suppressions dans les deux sens, sans doublon, de façon idempotente", async () => {
    const r = new FakeRemote();
    const pc = await device();
    const ipad = await device();
    const lead = pc.createLead({ name: "Zinc", email: "z@z.fr" });
    pc.addDraft(lead.id, draftOut, "t");
    pc.addSuppression("no@x.fr");
    expect((await syncOnce(pc, r)).pushed).toBe(3);
    expect((await syncOnce(ipad, r)).pulled).toBe(3);
    expect(ipad.listLeads()[0]).toMatchObject({ name: "Zinc", status: "drafted" });
    expect(ipad.isSuppressed("no@x.fr")).toBe(true);

    // l'iPad valide le brouillon ; le PC le récupère
    const d = ipad.listDrafts(lead.id)[0]!;
    ipad.updateDraft(d.id, { status: "approved", subject: "Nouveau sujet" });
    await syncOnce(ipad, r);
    await syncOnce(pc, r);
    expect(pc.listDrafts(lead.id)[0]).toMatchObject({ status: "approved", subject: "Nouveau sujet" });

    const w = r.writes;
    expect(await syncOnce(pc, r)).toMatchObject({ pushed: 0 });
    expect(await syncOnce(ipad, r)).toMatchObject({ pushed: 0 });
    expect(r.writes).toBe(w); // aucun aller-retour inutile (quota gratuit)
    expect(pc.listLeads()).toHaveLength(1);
  });

  it("une modification faite hors ligne puis poussée tard est quand même récupérée (curseur serveur)", async () => {
    const r = new FakeRemote();
    const pc = await device();
    const ipad = await device();
    const lead = pc.createLead({ name: "A" });
    await syncOnce(pc, r);
    await syncOnce(ipad, r);
    await syncOnce(pc, r); // le PC a déjà tiré jusqu'ici
    // l'iPad modifie « il y a longtemps » (date ancienne) mais pousse maintenant
    const row = ipad.getRow("leads", lead.id)!;
    ipad.putRow("leads", { ...row, name: "A modifié", updated_at: "2031-01-01T00:00:00.000Z" });
    await syncOnce(ipad, r);
    await syncOnce(pc, r);
    expect(pc.getLead(lead.id)!.name).toBe("A modifié");
  });

  it("dernière modification gagne", async () => {
    const r = new FakeRemote();
    const pc = await device();
    const ipad = await device();
    const lead = pc.createLead({ name: "Base" });
    await syncOnce(pc, r);
    await syncOnce(ipad, r);
    pc.putRow("leads", { ...pc.getRow("leads", lead.id)!, name: "PC", updated_at: "2032-01-01T00:00:00.000Z" });
    ipad.putRow("leads", { ...ipad.getRow("leads", lead.id)!, name: "iPad", updated_at: "2032-06-01T00:00:00.000Z" });
    await syncOnce(pc, r);
    await syncOnce(ipad, r);
    await syncOnce(pc, r);
    expect(pc.getLead(lead.id)!.name).toBe("iPad");
    expect(ipad.getLead(lead.id)!.name).toBe("iPad");
  });

  it("un statut « envoyé » n'est jamais écrasé par une copie plus récente mais périmée (anti double envoi)", async () => {
    const r = new FakeRemote();
    const pc = await device();
    const ipad = await device();
    const lead = pc.createLead({ name: "Zinc" });
    await syncOnce(pc, r);
    await syncOnce(ipad, r);
    pc.setLeadStatus(lead.id, "sent"); // le PC envoie
    // l'iPad, pas encore synchronisé, modifie le lead avec une date plus récente
    ipad.putRow("leads", { ...ipad.getRow("leads", lead.id)!, name: "Zinc bar", status: "new", updated_at: "2099-01-01T00:00:00.000Z" });
    await syncOnce(pc, r);
    await syncOnce(ipad, r);
    await syncOnce(pc, r);
    await syncOnce(ipad, r);
    expect(pc.getLead(lead.id)!.status).toBe("sent");
    expect(ipad.getLead(lead.id)!.status).toBe("sent");
    expect(pc.getLead(lead.id)!.name).toBe("Zinc bar"); // le reste de la modification est conservé
  });

  it("deux fiches Google identiques créées sur deux appareils : rien n'est supprimé", async () => {
    const r = new FakeRemote();
    const pc = await device();
    const ipad = await device();
    pc.createLead({ name: "Bar", placeId: "osm:node/1" });
    ipad.createLead({ name: "Bar", placeId: "osm:node/1" });
    await syncOnce(pc, r);
    await syncOnce(ipad, r);
    await syncOnce(pc, r);
    expect(pc.listLeads()).toHaveLength(1);
    expect(ipad.listLeads()).toHaveLength(1);
  });

  it("mergeRows : statuts de brouillon", () => {
    const a = { id: "1", status: "sent", updated_at: "2030-01-01T00:00:00.000Z" };
    const b = { id: "1", status: "approved", updated_at: "2031-01-01T00:00:00.000Z" };
    expect(mergeRows("drafts", a, b).row.status).toBe("sent");
  });
});

describe("client Firestore / Auth", () => {
  it("connexion, renouvellement, requêtes typées, erreurs lisibles", async () => {
    const calls: { url: string; body: any; auth?: string }[] = [];
    const f = (async (url: string, init: any) => {
      calls.push({ url, body: init.body ? (String(init.body).startsWith("{") ? JSON.parse(init.body) : init.body) : null, auth: init.headers?.Authorization });
      if (url.includes("signInWithPassword")) return { ok: true, status: 200, json: async () => ({ idToken: "ID1", refreshToken: "RT1", expiresIn: "3600" }) };
      if (url.includes(":runQuery"))
        return { ok: true, status: 200, json: async () => [{ document: { name: "projects/p/databases/(default)/documents/leads/a%40b.fr", fields: { u: { stringValue: "U" }, j: { stringValue: "{}" }, p: { timestampValue: "2030-01-01T00:00:00Z" } } } }, {}] };
      return { ok: true, status: 200, json: async () => ({}) };
    }) as any;
    let saved = "";
    const auth = new FirebaseAuth({ apiKey: "K", email: "e@x.fr", password: "pw" }, f, { onRefreshToken: (t) => (saved = t) });
    const fr = new FirestoreRemote("p", auth, f);
    const docs = await fr.pull("leads", "2030-01-01T00:00:00Z", 10);
    expect(docs).toEqual([{ id: "a@b.fr", u: "U", j: "{}", p: "2030-01-01T00:00:00Z" }]);
    expect(saved).toBe("RT1");
    const q = calls.find((c) => c.url.includes("runQuery"))!;
    expect(q.auth).toBe("Bearer ID1");
    expect(q.body.structuredQuery.where.fieldFilter.op).toBe("GREATER_THAN_OR_EQUAL");
    await fr.commit([{ col: "leads", id: "x", u: "U", j: "{}" }]);
    const c = calls.find((x) => x.url.endsWith(":commit"))!;
    expect(c.body.writes[0].updateTransforms[0]).toEqual({ fieldPath: "p", setToServerValue: "REQUEST_TIME" });
    expect(calls.filter((x) => x.url.includes("signIn"))).toHaveLength(1); // jeton réutilisé

    const bad = (async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "INVALID_LOGIN_CREDENTIALS" } }) })) as any;
    await expect(new FirebaseAuth({ apiKey: "K", email: "e", password: "x" }, bad).token()).rejects.toThrow(/incorrect/);
    const denied = (async (u: string) => (u.includes("signIn") ? { ok: true, json: async () => ({ idToken: "t", expiresIn: "3600" }) } : { ok: false, status: 403, json: async () => ({ error: { status: "PERMISSION_DENIED" } }) })) as any;
    await expect(new FirestoreRemote("p", new FirebaseAuth({ apiKey: "K", email: "e", password: "x" }, denied), denied).pull("leads", null, 5)).rejects.toThrow(/règles/);
  });
});
