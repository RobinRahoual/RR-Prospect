import { app, BrowserWindow, Notification, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import dns from "node:dns/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  buildPrompt, buildSystem, Database, executeTool, GeminiChat, GeminiEngine, gpuCheck, HintError, LLMRouter, OllamaChat,
  OllamaEngine, pullModel, geocode, normalizeScan, runScan, analyzeLead, isPublicHost, mailStatus, normalizeMail, sendBatch, sendDraft, isEmail, buildMessage, FirebaseAuth, FirestoreRemote, FIRESTORE_RULES, syncOnce, processInbox, senderFilter, deployTracker, Tracker, Repo, runAgent, TOOLS, testGeminiKey, trimHistory,
  type DraftStatus, type LeadInput, type Mode,
} from "../core";
import type { SetupParams, SetupStep, StepResult } from "../shared/ipc";
import { checkNow, initUpdater, installNow, updateState } from "./updater";
import { gmailTransport } from "./mail";
import { fetchInbound } from "./imap";
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

function tracker(): Tracker | null {
  const t = cfg.getTrack();
  return t ? new Tracker(t.url, t.secret) : null;
}

let syncing = false;
let syncLast: { at: string | null; error: string | null } = { at: null, error: null };
async function runSync(wc?: Electron.WebContents) {
  const fb = cfg.getFirebase();
  if (!fb || syncing) return { pulled: 0, pushed: 0 };
  syncing = true;
  try {
    const remote = new FirestoreRemote(fb.projectId, new FirebaseAuth({ apiKey: fb.apiKey, email: fb.email, password: fb.password }));
    const r = await syncOnce(repo, remote);
    syncLast = { at: new Date().toISOString(), error: null };
    wc?.send("sync:done", r);
    return r;
  } catch (e) {
    syncLast = { at: syncLast.at, error: (e as Error).message };
    wc?.send("sync:done", { pulled: 0, pushed: 0, error: (e as Error).message });
    throw e;
  } finally {
    syncing = false;
  }
}
function syncState() {
  const f = cfg.v.firebase;
  return {
    configured: !!cfg.getFirebase(),
    projectId: f?.projectId ?? "",
    apiKey: f?.apiKey ?? "",
    email: f?.email ?? "",
    hasPassword: !!cfg.getFirebase(),
    lastAt: syncLast.at,
    lastError: syncLast.error,
    rules: FIRESTORE_RULES(f?.email || "ton-email@exemple.fr"),
  };
}

let inboxBusy = false;
async function checkInbox(wc?: Electron.WebContents) {
  const pass = cfg.getMailPass();
  const s = cfg.mail;
  if (!pass || !isEmail(s.address)) throw new Error("Configure d'abord Gmail dans Réglages");
  if (inboxBusy) return { replies: 0, stops: 0, bounces: 0, checked: 0 };
  inboxBusy = true;
  try {
    const first = repo.firstSendAt();
    if (!first) return { replies: 0, stops: 0, bounces: 0, checked: 0 };
    const since = new Date(Math.max(new Date(first).getTime() - 86400_000, Date.now() - 60 * 86400_000));
    const mails = await fetchInbound(s.address, pass, since, senderFilter(repo.listLeads()));
    const r = processInbox(repo, mails);
    cfg.set({ lastInboxCheck: new Date().toISOString() });
    if (r.replies + r.stops + r.bounces > 0) {
      wc?.send("inbox:new", r);
      if (Notification.isSupported() && r.replies > 0) new Notification({ title: "RR Prospect", body: `${r.replies} nouvelle(s) réponse(s) de prospects` }).show();
    }
    return r;
  } catch (e) {
    const m = (e as Error).message;
    throw new Error(/AUTHENTICATIONFAILED|Invalid credentials|authenticat/i.test(m) ? "Gmail refuse la connexion IMAP (vérifie le mot de passe d'application)." : /ENOTFOUND|ETIMEDOUT|ECONN/i.test(m) ? "Connexion à Gmail impossible : vérifie ta connexion internet." : m);
  } finally {
    inboxBusy = false;
  }
}

async function refreshOpens() {
  const t = tracker();
  if (!t) return {};
  const ids = repo.listTrackIds();
  if (ids.length) {
    for (let i = 0; i < ids.length; i += 200) {
      const stats = await t.stats(ids.slice(i, i + 200));
      for (const [id, v] of Object.entries(stats)) repo.setOpens(id, v.opens, v.first, v.last);
    }
  }
  return repo.opensByLead();
}

let stopBatch = false;
let batchRunning = false;

function mailState() {
  const settings = cfg.mail;
  const st = mailStatus(repo, settings);
  return { settings, hasPassword: !!cfg.getMailPass(), ...st };
}
function transport() {
  const pass = cfg.getMailPass();
  if (!pass || !cfg.mail.address) throw new Error("Configure ton adresse Gmail et ton mot de passe d'application dans Réglages");
  return gmailTransport(cfg.mail.address, pass);
}

/** Résout le nom d'hôte et refuse les adresses privées (anti-SSRF : l'URL d'un site vient de données externes). */
async function resolvesPublic(host: string): Promise<boolean> {
  try {
    const addrs = await dns.lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => isPublicHost(a.address));
  } catch {
    return false;
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
      scan: async (o: Partial<import("../core").ScanSettings>) => {
        const settings = normalizeScan(o, cfg.scan);
        return { ...(await runScan(repo, settings, { openAgendaKey: cfg.getOaKey() })), settings };
      },
      analyze: (lead: import("../core").Lead) => analyzeLead(repo, lead, fetch, resolvesPublic),
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

  handle("scan:get", () => cfg.scan);
  handle("scan:set", (_e, patch: Partial<import("../core").ScanSettings>) => {
    const s = normalizeScan(patch, cfg.scan);
    cfg.set({ scan: s });
    return s;
  });
  handle("scan:geocode", (_e, q: string) => geocode(String(q)));
  handle("scan:run", (e) => runScan(repo, cfg.scan, { openAgendaKey: cfg.getOaKey(), onLog: (l) => e.sender.send("scan:log", l) }));
  handle("scan:hasOaKey", () => !!cfg.getOaKey());
  handle("scan:setOaKey", (_e, k: string) => cfg.setOaKey(String(k ?? "").trim()));
  handle("leads:analyze", async (_e, id: string) => {
    const lead = repo.getLead(id);
    if (!lead) throw new Error("Lead introuvable");
    const r = await analyzeLead(repo, lead, fetch, resolvesPublic);
    return { lead: r.lead, note: r.note };
  });

  handle("mail:get", () => mailState());
  handle("mail:set", (_e, patch: Partial<import("../core").MailSettings>, pass?: string) => {
    cfg.set({ mail: normalizeMail(patch, cfg.mail) });
    if (typeof pass === "string" && pass.trim()) cfg.setMailPass(pass.trim());
    return mailState();
  });
  handle("mail:test", async () => {
    const s = cfg.mail;
    if (!isEmail(s.address)) return { ok: false, error: "Renseigne ton adresse Gmail" };
    try {
      const m = buildMessage(s, s.address, "Test RR Prospect", "<p>Ceci est un message de test envoyé par RR Prospect. Si tu le lis, l'envoi fonctionne.</p>");
      const r = await transport().send(m);
      return { ok: true, to: s.address, messageId: r.messageId };
    } catch (e) {
      const { friendlyMailError } = await import("../core");
      return { ok: false, error: friendlyMailError((e as Error).message) };
    }
  });
  handle("mail:send", async (e, draftId: string) => {
    const r = await sendDraft(repo, transport(), cfg.mail, String(draftId), { tracker: tracker() });
    if (r.ok) runSync(e.sender).catch(() => undefined); // l'iPad doit savoir tout de suite que c'est parti
    return r;
  });
  handle("mail:sendApproved", async (e) => {
    if (batchRunning) throw new Error("Un envoi groupé est déjà en cours");
    batchRunning = true;
    stopBatch = false;
    try {
      return await sendBatch(repo, transport(), cfg.mail, {
        tracker: tracker(),
        shouldStop: () => stopBatch,
        onProgress: (p) => {
          e.sender.send("mail:progress", p);
          if (p.result?.ok) runSync(e.sender).catch(() => undefined);
        },
      });
    } finally {
      batchRunning = false;
    }
  });
  handle("mail:cancel", () => {
    stopBatch = true;
  });
  handle("leads:get", (_e, id: string) => repo.getLead(String(id)));
  handle("leads:suppress", (_e, id: string) => {
    const l = repo.getLead(String(id));
    if (!l) return null;
    if (l.email) repo.addSuppression(l.email, "ne pas contacter (manuel)");
    repo.setLeadStatus(l.id, "skipped");
    return repo.getLead(l.id);
  });

  handle("sync:get", () => syncState());
  handle("sync:set", async (e, c: { projectId: string; apiKey: string; email: string }, pass?: string) => {
    const clean = { projectId: String(c.projectId).trim(), apiKey: String(c.apiKey).trim(), email: String(c.email).trim() };
    if (!clean.projectId || !clean.apiKey || !clean.email) throw new Error("Renseigne l'identifiant du projet, la clé API et l'email");
    cfg.setFirebase(clean, pass?.trim() || undefined);
    if (!cfg.getFirebase()) throw new Error("Renseigne aussi le mot de passe");
    await runSync(e.sender); // teste la connexion tout de suite : l'erreur remonte à l'écran
    return syncState();
  });
  handle("sync:run", (e) => runSync(e.sender));
  handle("sync:disable", () => {
    cfg.setFirebase(null);
    return syncState();
  });
  handle("inbox:check", (e) => checkInbox(e.sender));
  handle("inbox:list", () => repo.listInbound(50));
  handle("track:get", () => ({ enabled: !!cfg.getTrack(), url: cfg.getTrack()?.url ?? null }));
  handle("track:install", async (e, token: string) => {
    const secret = randomBytes(24).toString("hex");
    const r = await deployTracker({ token: String(token).trim(), secret }, fetch, (l) => e.sender.send("track:log", l));
    cfg.setTrack(r.url, secret);
    return { enabled: true, url: r.url };
  });
  handle("track:disable", () => {
    cfg.clearTrack();
    return { enabled: false, url: null };
  });
  handle("track:refresh", () => refreshOpens());
  handle("track:opens", () => repo.opensByLead());

  handle("update:state", () => updateState());
  handle("update:check", () => checkNow());
  handle("update:install", () => installNow());

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
  win.webContents.once("did-finish-load", () => initUpdater(win.webContents));

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
  // Tâches de fond : boîte de réception et ouvertures, toutes les 15 min (si configurés)
  const tick = () => {
    const wc = BrowserWindow.getAllWindows()[0]?.webContents;
    if (cfg.getMailPass() && cfg.mail.address) checkInbox(wc).catch(() => undefined);
    refreshOpens().catch(() => undefined);
  };
  const syncTick = () => runSync(BrowserWindow.getAllWindows()[0]?.webContents).catch(() => undefined);
  setTimeout(syncTick, 10_000);
  setInterval(syncTick, 5 * 60_000);
  setTimeout(tick, 30_000);
  setInterval(tick, 15 * 60_000);
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
