import { app, BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import {
  buildPrompt, buildSystem, Database, executeTool, GeminiChat, GeminiEngine, gpuCheck, HintError, LLMRouter, OllamaChat,
  OllamaEngine, pullModel, Repo, runAgent, TOOLS, testGeminiKey, trimHistory,
  type DraftStatus, type LeadInput, type Mode,
} from "../core";
import type { SetupParams, SetupStep, StepResult } from "../shared/ipc";
import { ConfigStore } from "./config";
import { enableVulkan, ensureRunning, installOllama, resolveBin } from "./ollama-setup";

// Une seule instance : sql.js réécrit tout le fichier, deux instances s'écraseraient
if (!app.requestSingleInstanceLock()) app.quit();

let db: Database;
let repo: Repo;
let cfg: ConfigStore;

/** Seule l'interface locale (file://) peut appeler le processus principal. */
function handle(channel: string, fn: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!event.senderFrame?.url.startsWith("file://")) throw new Error("Origine non autorisée");
    return fn(event, ...args);
  });
}

function buildRouter(): LLMRouter {
  const c = cfg.v;
  const local = new OllamaEngine({
    baseUrl: c.ollamaUrl,
    model: c.ollamaModel,
    ensureRunning: () => ensureRunning(c.ollamaUrl),
  });
  const key = cfg.getGeminiKey();
  const cloud =
    key && c.geminiModel ? new GeminiEngine({ apiKey: key, model: c.geminiModel, fallbackModel: c.geminiFallback }) : null;
  return new LLMRouter(local, cloud);
}

/* ---------------- Assistant d'installation (100 % local) ---------------- */
async function runStep(name: SetupStep, p: SetupParams, log: (l: string) => void): Promise<StepResult> {
  const url = cfg.v.ollamaUrl;
  switch (name) {
    case "ollama": {
      if (resolveBin()) log("Ollama est déjà installé.");
      else await installOllama(log);
      if (!(await ensureRunning(url))) {
        throw new HintError("Ollama est installé mais ne démarre pas.", "Redémarre le PC puis relance l'assistant.");
      }
      return { ok: true, detail: "Ollama prêt" };
    }
    case "model": {
      const model = (p.model || cfg.v.ollamaModel).trim();
      if (!(await ensureRunning(url))) throw new HintError("Ollama ne répond pas.", "Relance l'étape précédente.");
      await pullModel(url, model, log);
      cfg.set({ ollamaModel: model });
      return { ok: true, detail: `${model} téléchargé` };
    }
    case "gpu": {
      log("Test de génération et mesure de l'occupation du GPU…");
      let r = await gpuCheck(url, cfg.v.ollamaModel);
      if (r.pct < 90) {
        log(`Seulement ${r.pct}% sur GPU → activation de Vulkan et redémarrage d'Ollama…`);
        await enableVulkan(url);
        r = await gpuCheck(url, cfg.v.ollamaModel);
      }
      if (r.pct < 90) {
        return {
          ok: true,
          detail: `GPU ${r.pct}%`,
          warn: "Le modèle tourne surtout sur le processeur (lent). Mets à jour le pilote AMD Adrenalin puis relance l'assistant.",
        };
      }
      return { ok: true, detail: `${r.pct}% sur GPU (modèle de ${r.gb} Go)` };
    }
    case "gemini": {
      const key = p.geminiKey?.trim();
      if (!key) return { ok: true, detail: "Ignoré — l'app fonctionne 100 % en local (tu pourras l'ajouter plus tard)" };
      log("Vérification de la clé et des modèles…");
      const r = await testGeminiKey(key, "gemini-pro-latest", "gemini-flash-latest");
      if (!r.keyOk) {
        throw new HintError(`Clé refusée par Google (${r.status}).`, "Recrée une clé sur https://aistudio.google.com/apikey et recolle-la.");
      }
      if (!r.pro && !r.flash) throw new HintError("Aucun modèle Gemini utilisable avec cette clé.", r.proMsg ?? "");
      cfg.setGeminiKey(key);
      cfg.set({ geminiModel: r.pro ?? r.flash, geminiFallback: r.flash ?? r.pro });
      if (!r.pro) {
        return {
          ok: true,
          detail: `Flash : ${r.flash}`,
          warn: `Pro indisponible avec cette clé (${r.proMsg}). Active la facturation à l'usage dans AI Studio pour l'utiliser ; en attendant l'app utilise Flash.`,
        };
      }
      return { ok: true, detail: `Pro : ${r.pro}${r.flash ? ` · repli ${r.flash}` : ""}` };
    }
  }
}

/* ---------------- Chat agent ---------------- */
const busy = new Set<string>();

async function sendChat(event: IpcMainInvokeEvent, convId: string, text: string) {
  const clean = text.trim().slice(0, 8000);
  if (!clean) return;
  if (busy.has(convId)) throw new Error("Une réponse est déjà en cours dans cette conversation.");
  busy.add(convId);
  try {
    const first = repo.getMessages(convId).length === 0;
    const emit = (m: unknown) => event.sender.send("chat:message", m);
    emit(repo.addMessage(convId, { role: "user", content: clean }));
    if (first) repo.renameConversation(convId, clean.replace(/\s+/g, " ").slice(0, 48));

    const c = cfg.v;
    const key = cfg.getGeminiKey();
    const local = new OllamaChat({ baseUrl: c.ollamaUrl, model: c.ollamaModel, ensureRunning: () => ensureRunning(c.ollamaUrl) });
    const cloud = key && c.geminiModel ? new GeminiChat({ apiKey: key, model: c.geminiModel, fallbackModel: c.geminiFallback ?? undefined }) : null;
    const router = buildRouter();
    const deps = {
      repo,
      generateDraft: async (lead: import("../core").Lead, instructions?: string) =>
        router.generate(buildPrompt(lead, { instructions, examples: repo.listApprovedExamples(3) }), c.mode),
    };

    await runAgent(
      {
        local,
        cloud,
        mode: c.mode,
        system: buildSystem(repo),
        tools: TOOLS,
        execute: (call) => executeTool(deps, call),
        onMessage: (m) => emit(repo.addMessage(convId, m)),
      },
      trimHistory(repo.getMessages(convId))
    );
  } finally {
    busy.delete(convId);
  }
}

function registerIpc() {
  handle("config:get", () => cfg.toPublic());
  handle("config:setMode", (_e, mode: Mode) => {
    if (!["auto", "local", "cloud"].includes(mode)) throw new Error("Mode invalide");
    cfg.set({ mode });
  });

  handle("setup:step", async (event, name: SetupStep, params: SetupParams) => {
    const log = (l: string) => event.sender.send("setup:log", l);
    try {
      return await runStep(name, params ?? {}, log);
    } catch (e) {
      return { ok: false, error: (e as Error).message, hint: e instanceof HintError ? e.hint : "" } satisfies StepResult;
    }
  });
  handle("setup:finish", () => cfg.set({ setupDone: true }));

  handle("chat:list", () => repo.listConversations());
  handle("chat:create", () => repo.createConversation());
  handle("chat:messages", (_e, id: string) => repo.getMessages(id));
  handle("chat:send", (e, id: string, text: string) => sendChat(e, id, text));
  handle("chat:remove", (_e, id: string) => repo.deleteConversation(id));

  handle("leads:list", () => repo.listLeads());
  handle("leads:create", (_e, input: LeadInput) => repo.createLead(input));

  handle("drafts:list", (_e, leadId: string) => repo.listDrafts(leadId));
  handle("drafts:generate", async (_e, leadId: string, mode?: Mode) => {
    const lead = repo.getLead(leadId);
    if (!lead) throw new Error("Lead introuvable");
    const r = await buildRouter().generate(buildPrompt(lead), mode ?? cfg.v.mode);
    return repo.addDraft(lead.id, r.draft, r.engine);
  });
  handle("drafts:update", (_e, id: string, patch: { subject?: string; bodyHtml?: string; status?: DraftStatus }) =>
    repo.updateDraft(id, patch)
  );
}

/* ---------------- Fenêtre ---------------- */
function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 760,
    backgroundColor: "#0b0b0f",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, "../renderer/index.html"));

  // Les liens http(s) s'ouvrent dans le navigateur par défaut, jamais dans l'app
  const external = (url: string) => /^(https?:|mailto:)/i.test(url) && shell.openExternal(url);
  win.webContents.setWindowOpenHandler(({ url }) => {
    external(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file://")) {
      e.preventDefault();
      external(url);
    }
  });
}

app.whenReady().then(async () => {
  cfg = new ConfigStore();
  db = await Database.open(path.join(app.getPath("userData"), "rr-prospect.db"), __dirname);
  repo = new Repo(db);
  repo.migrate();
  registerIpc();
  createWindow();
});

app.on("second-instance", () => {
  const w = BrowserWindow.getAllWindows()[0];
  if (w) {
    if (w.isMinimized()) w.restore();
    w.focus();
  }
});
app.on("before-quit", () => db?.flush());
app.on("window-all-closed", () => app.quit());
