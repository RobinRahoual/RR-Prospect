import { describe, expect, it } from "vitest";
import { Database, Repo, runAgent, executeTool, toGeminiContents, toOllamaMessages, trimHistory, GeminiChat, TOOLS } from "../index";
import type { ChatEngine, ChatMessage, ChatReply } from "../index";

async function mkRepo() {
  const db = await Database.open();
  const repo = new Repo(db);
  repo.migrate();
  return repo;
}
const fakeDraft = { subject: "Sujet", bodyHtml: "<p>Bonjour</p>", hookUsed: "photos", confidence: 0.8 };

describe("conversion des messages", () => {
  const msgs: ChatMessage[] = [
    { role: "user", content: "salut" },
    { role: "assistant", content: "", toolCalls: [{ id: "1", name: "a", args: { x: 1 } }, { id: "2", name: "b", args: {} }] },
    { role: "tool", content: '{"ok":1}', toolCallId: "1", toolName: "a" },
    { role: "tool", content: "pas du json", toolCallId: "2", toolName: "b" },
  ];
  it("Gemini : fusionne les réponses d'outils en un seul message", () => {
    const c = toGeminiContents(msgs);
    expect(c.map((x) => x.role)).toEqual(["user", "model", "user"]);
    expect(c[2]!.parts).toHaveLength(2);
    expect((c[2]!.parts[1] as any).functionResponse.response).toEqual({ result: "pas du json" });
  });
  it("Gemini : rejoue les parties brutes", () => {
    const raw = [{ functionCall: { name: "a", args: {} }, thoughtSignature: "sig" }];
    const c = toGeminiContents([{ role: "assistant", content: "", raw: { family: "gemini", parts: raw } }]);
    expect(c[0]!.parts).toEqual(raw);
  });
  it("Ollama : format tool_calls / tool", () => {
    const o = toOllamaMessages("sys", msgs);
    expect(o[0]).toEqual({ role: "system", content: "sys" });
    expect(o[2]!.tool_calls![0]!.function).toEqual({ name: "a", arguments: { x: 1 } });
    expect(o[3]).toMatchObject({ role: "tool", tool_name: "a" });
  });
  it("trimHistory commence sur un message utilisateur", () => {
    const h: ChatMessage[] = [
      { role: "user", content: "1" },
      { role: "assistant", content: "2" },
      { role: "tool", content: "3" },
      { role: "user", content: "4" },
    ];
    expect(trimHistory(h, 3)[0]!.content).toBe("4");
  });
});

describe("outils", () => {
  it("crée, cherche, génère un brouillon et résout les références", async () => {
    const repo = await mkRepo();
    const deps = { repo, generateDraft: async () => ({ draft: fakeDraft, engine: "test" }) };
    const created = await executeTool(deps, { id: "c", name: "create_lead", args: { name: "Bar Le Zinc", city: "Dijon" } });
    expect(created.cards?.[0]?.type).toBe("leads");
    const s = await executeTool(deps, { id: "c", name: "search_leads", args: { query: "zinc" } });
    expect((s.result as any).count).toBe(1);
    const g = await executeTool(deps, { id: "c", name: "generate_draft", args: { lead: "zinc" } });
    expect(g.cards?.[0]).toMatchObject({ type: "draft", leadName: "Bar Le Zinc" });
    expect(repo.listLeads()[0]!.status).toBe("drafted");
    await expect(executeTool(deps, { id: "c", name: "get_lead", args: { lead: "inconnu" } })).rejects.toThrow(/Aucun lead/);
    await expect(executeTool(deps, { id: "c", name: "nope", args: {} })).rejects.toThrow(/inconnu/);
  });
  it("refuse un contact en liste de suppression", async () => {
    const repo = await mkRepo();
    repo.createLead({ name: "Chez Paul", email: "paul@x.fr" });
    repo.addSuppression("paul@x.fr");
    const deps = { repo, generateDraft: async () => ({ draft: fakeDraft, engine: "t" }) };
    await expect(executeTool(deps, { id: "c", name: "generate_draft", args: { lead: "paul" } })).rejects.toThrow(/suppression/);
  });
});

describe("agent", () => {
  const script = (replies: ChatReply[]): ChatEngine => ({ chat: async () => replies.shift()! });
  const failing: ChatEngine = { isAvailable: async () => true, chat: async () => { throw new Error("boom"); } };

  it("boucle outil → réponse finale", async () => {
    const seen: ChatMessage[] = [];
    const eng = script([
      { content: "", toolCalls: [{ id: "1", name: "get_overview", args: {} }], engine: "e" },
      { content: "Voilà", toolCalls: [], engine: "e" },
    ]);
    const out = await runAgent(
      { local: null, cloud: eng, mode: "cloud", system: "s", tools: TOOLS, execute: async () => ({ result: { ok: true } }), onMessage: (m) => void seen.push(m) },
      [{ role: "user", content: "yo" }]
    );
    expect(out.map((m) => m.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(seen).toHaveLength(3);
  });
  it("auto : bascule sur le cloud si le local échoue", async () => {
    const cloud = script([{ content: "ok", toolCalls: [], engine: "gemini:x" }]);
    const out = await runAgent({ local: failing, cloud, mode: "auto", system: "s", tools: [], execute: async () => ({ result: 1 }) }, [{ role: "user", content: "a" }]);
    expect(out[0]!.engine).toBe("gemini:x");
  });
  it("local seul et injoignable : erreur claire", async () => {
    const down: ChatEngine = { isAvailable: async () => false, chat: async () => { throw new Error("x"); } };
    await expect(runAgent({ local: down, cloud: null, mode: "local", system: "s", tools: [], execute: async () => ({ result: 1 }) }, [])).rejects.toThrow(/Ollama/);
  });
  it("une erreur d'outil est renvoyée au modèle, pas jetée", async () => {
    const eng = script([
      { content: "", toolCalls: [{ id: "1", name: "x", args: {} }], engine: "e" },
      { content: "fini", toolCalls: [], engine: "e" },
    ]);
    const out = await runAgent({ local: null, cloud: eng, mode: "cloud", system: "s", tools: [], execute: async () => { throw new Error("KO"); } }, [{ role: "user", content: "a" }]);
    expect(out[1]!.content).toContain("KO");
  });
});

describe("GeminiChat", () => {
  it("envoie systemInstruction + functionDeclarations et lit functionCall (avec repli de modèle)", async () => {
    const calls: { url: string; body: any }[] = [];
    const f = (async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      if (calls.length === 1) return { ok: false, status: 503, json: async () => ({ error: { message: "busy" } }) };
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ functionCall: { name: "get_overview", args: {} } }] } }] }) };
    }) as any;
    const g = new GeminiChat({ apiKey: "k", model: "pro", fallbackModel: "flash", fetchImpl: f });
    const r = await g.chat("sys", [{ role: "user", content: "hi" }], TOOLS);
    expect(r.engine).toBe("gemini:flash");
    expect(r.toolCalls[0]!.name).toBe("get_overview");
    expect(calls[0]!.body.systemInstruction.parts[0].text).toBe("sys");
    expect(calls[0]!.body.tools[0].functionDeclarations.length).toBe(TOOLS.length);
  });
});

describe("persistance du chat", () => {
  it("conversations, messages (JSON), exemples validés", async () => {
    const repo = await mkRepo();
    const c = repo.createConversation();
    repo.addMessage(c.id, { role: "user", content: "a" });
    repo.addMessage(c.id, { role: "assistant", content: "b", toolCalls: [{ id: "1", name: "x", args: { y: 1 } }], raw: { family: "gemini", parts: [{ text: "b" }] } });
    const m = repo.getMessages(c.id);
    expect(m.map((x) => x.role)).toEqual(["user", "assistant"]);
    expect(m[1]!.toolCalls![0]!.args).toEqual({ y: 1 });
    const l = repo.createLead({ name: "L" });
    const d = repo.addDraft(l.id, fakeDraft, "t");
    expect(repo.listApprovedExamples()).toHaveLength(0);
    repo.updateDraft(d.id, { status: "approved" });
    expect(repo.listApprovedExamples()[0]!.body).toBe("Bonjour");
    repo.deleteConversation(c.id);
    expect(repo.listConversations()).toHaveLength(0);
  });
});
