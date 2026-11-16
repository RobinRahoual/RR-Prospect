import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Database } from "../db";
import { LLMError } from "../errors";
import { GeminiEngine } from "../llm/gemini";
import { pickLatest } from "../llm/gemini-setup";
import { LLMRouter, type CloudEngine, type LocalEngine } from "../llm/router";
import { parseDraft } from "../parse";
import { buildPrompt } from "../prompts";
import { Repo } from "../repo";
import type { DraftOut, Lead } from "../types";

const GOOD = JSON.stringify({
  subject: "Vos photos Google ont 8 mois",
  body_html: "<p>Bonjour, votre fiche Google compte 6 photos.</p>",
  hook_used: "6 photos",
  confidence: 0.8,
});
const DRAFT: DraftOut = { subject: "Sujet test", bodyHtml: "<p>Corps du message de test</p>", hookUsed: "x", confidence: 0.5 };

describe("parseDraft", () => {
  it("accepte JSON brut, bloc ```json et texte autour", () => {
    expect(parseDraft(GOOD).subject).toMatch(/^Vos photos/);
    expect(parseDraft("```json\n" + GOOD + "\n```").confidence).toBe(0.8);
    expect(parseDraft("Voici :\n" + GOOD + "\nBonne journée").hookUsed).toBe("6 photos");
  });
  it.each(["", "pas de json", "{not json}", '{"subject":"x"}'])("rejette %j", (bad) => {
    expect(() => parseDraft(bad)).toThrow(LLMError);
  });
});

describe("buildPrompt", () => {
  const lead = {
    kind: "business", name: "Bar Test", category: "bar", city: "Dijon", website: null, rating: 4.2,
    photoCount: 6, lastReviewAt: "2026-03-10T00:00:00Z", gapScore: 80, gapReasons: ["pas de site web"],
  } as Lead;
  it("contient les faits du lead et le profil de Robin", () => {
    const p = buildPrompt(lead);
    expect(p.user).toContain("Bar Test");
    expect(p.user).toContain("AUCUN site web");
    expect(p.user).toContain("03/2026");
    expect(p.system).toContain("robinrahoual.fr");
    expect(p.system).toContain("Sony A7 III");
  });
});

// --- Gemini : repli Pro -> Flash ------------------------------------------------------------
function fakeFetch(behaviour: Record<string, { status: number; body: unknown }>, calls: string[]): typeof fetch {
  return (async (url: string) => {
    const model = /models\/([^:]+):/.exec(url)![1]!;
    calls.push(model);
    const b = behaviour[model]!;
    return new Response(JSON.stringify(b.body), { status: b.status });
  }) as unknown as typeof fetch;
}
const ok = { status: 200, body: { candidates: [{ content: { parts: [{ text: GOOD }] } }] } };
const quota = { status: 429, body: { error: { message: "RESOURCE_EXHAUSTED" } } };
const bad = { status: 400, body: { error: { message: "API key not valid" } } };

describe("GeminiEngine", () => {
  const prompt = { system: "s", user: "u" };
  it("bascule sur Flash quand Pro est en quota", async () => {
    const calls: string[] = [];
    const e = new GeminiEngine({ apiKey: "k", model: "pro", fallbackModel: "flash", fetchImpl: fakeFetch({ pro: quota, flash: ok }, calls) });
    const r = await e.generate(prompt);
    expect(r.engine).toBe("gemini:flash");
    expect(calls).toEqual(["pro", "flash"]);
  });
  it("reste sur Pro quand tout va bien", async () => {
    const calls: string[] = [];
    const e = new GeminiEngine({ apiKey: "k", model: "pro", fallbackModel: "flash", fetchImpl: fakeFetch({ pro: ok, flash: ok }, calls) });
    expect((await e.generate(prompt)).engine).toBe("gemini:pro");
    expect(calls).toEqual(["pro"]);
  });
  it("n'insiste pas sur une clé invalide (400)", async () => {
    const calls: string[] = [];
    const e = new GeminiEngine({ apiKey: "k", model: "pro", fallbackModel: "flash", fetchImpl: fakeFetch({ pro: bad, flash: ok }, calls) });
    await expect(e.generate(prompt)).rejects.toThrow(LLMError);
    expect(calls).toEqual(["pro"]);
  });
  it("échoue si les deux modèles sont en quota", async () => {
    const e = new GeminiEngine({ apiKey: "k", model: "pro", fallbackModel: "flash", fetchImpl: fakeFetch({ pro: quota, flash: quota }, []) });
    await expect(e.generate(prompt)).rejects.toThrow(/Gemini indisponible/);
  });
  it("exige une clé", () => {
    expect(() => new GeminiEngine({ apiKey: "", model: "pro" })).toThrow(LLMError);
  });
});

describe("pickLatest", () => {
  const names = ["models/gemini-2.5-pro", "models/gemini-3.5-pro", "models/gemini-3.5-pro-preview", "models/gemini-3-flash", "models/gemini-3.5-flash-image"];
  it("choisit la version la plus récente exacte", () => {
    expect(pickLatest(names, "pro")).toBe("gemini-3.5-pro");
    expect(pickLatest(names, "flash")).toBe("gemini-3-flash");
  });
});

// --- Routeur ----------------------------------------------------------------------------------
const engine = (name: string, fail = false): CloudEngine => ({
  generate: async () => {
    if (fail) throw new LLMError(`${name} KO`);
    return { draft: DRAFT, engine: name };
  },
});
const local = (up: boolean, fail = false): LocalEngine => ({ ...engine("ollama", fail), isAvailable: async () => up });

describe("LLMRouter", () => {
  it("auto : local d'abord", async () => {
    expect((await new LLMRouter(local(true), engine("gemini")).generate({ system: "", user: "" }, "auto")).engine).toBe("ollama");
  });
  it("auto : Ollama éteint → Gemini", async () => {
    expect((await new LLMRouter(local(false), engine("gemini")).generate({ system: "", user: "" }, "auto")).engine).toBe("gemini");
  });
  it("auto : Ollama en erreur → Gemini", async () => {
    expect((await new LLMRouter(local(true, true), engine("gemini")).generate({ system: "", user: "" }, "auto")).engine).toBe("gemini");
  });
  it("auto : rien de disponible → erreur claire", async () => {
    await expect(new LLMRouter(local(false), null).generate({ system: "", user: "" }, "auto")).rejects.toThrow(/Aucun moteur/);
  });
  it("local : n'utilise jamais Gemini", async () => {
    await expect(new LLMRouter(local(false), engine("gemini")).generate({ system: "", user: "" }, "local")).rejects.toThrow(/Ollama/);
  });
  it("cloud : n'utilise jamais Ollama", async () => {
    expect((await new LLMRouter(local(true), engine("gemini")).generate({ system: "", user: "" }, "cloud")).engine).toBe("gemini");
    await expect(new LLMRouter(local(true), null).generate({ system: "", user: "" }, "cloud")).rejects.toThrow(/clé Gemini/);
  });
});

// --- Base ---------------------------------------------------------------------------------------
describe("Repo (SQLite en mémoire)", () => {
  const make = async () => {
    const r = new Repo(await Database.open());
    r.migrate();
    return r;
  };
  it("crée, retrouve et trie les leads", async () => {
    const r = await make();
    const a = r.createLead({ name: "A", gapScore: 20, gapReasons: ["x", "y"] });
    const b = r.createLead({ name: "B", gapScore: 90 });
    expect(r.getLead(a.id)!.gapReasons).toEqual(["x", "y"]);
    expect(r.listLeads().map((l) => l.name)).toEqual(["B", "A"]);
    expect(b.status).toBe("new");
    expect(b.id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("refuse un doublon de fiche Google", async () => {
    const r = await make();
    r.createLead({ name: "A", placeId: "p1" });
    expect(() => r.createLead({ name: "A bis", placeId: "p1" })).toThrow(/déjà présent/);
  });
  it("gère les brouillons et le statut du lead", async () => {
    const r = await make();
    const l = r.createLead({ name: "A" });
    const d = r.addDraft(l.id, DRAFT, "ollama:x");
    expect(r.getLead(l.id)!.status).toBe("drafted");
    const u = r.updateDraft(d.id, { subject: "Nouveau sujet", status: "approved" });
    expect(u.subject).toBe("Nouveau sujet");
    expect(u.status).toBe("approved");
    expect(r.listDrafts(l.id)).toHaveLength(1);
    expect(() => r.updateDraft("nope", {})).toThrow();
  });
  it("persiste sur disque et se rouvre à l'identique", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-"));
    const file = path.join(dir, "sub", "test.db");
    const db1 = await Database.open(file);
    const r1 = new Repo(db1);
    r1.migrate();
    const l = r1.createLead({ name: "Persistant", gapReasons: ["a"] });
    db1.close();
    const r2 = new Repo(await Database.open(file));
    r2.migrate(); // idempotent
    expect(r2.getLead(l.id)!.name).toBe("Persistant");
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("liste de suppression insensible à la casse", async () => {
    const r = await make();
    r.addSuppression("Contact@Bar.fr");
    expect(r.isSuppressed("contact@bar.FR")).toBe(true);
    expect(r.isSuppressed("autre@bar.fr")).toBe(false);
  });
});
