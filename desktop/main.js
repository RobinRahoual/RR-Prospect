// Client Windows : assistant d'installation + webapp du NAS + pont Ollama local (window.localAI).
const { app, BrowserWindow, ipcMain, shell, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const ollama = require("./lib/ollama");
const gemini = require("./lib/gemini");
const nas = require("./lib/nas");
const { HintError } = require("./lib/errors");

const DEFAULTS = {
  appUrl: "",
  ollamaUrl: "http://127.0.0.1:11434",
  ollamaModel: "mistral-nemo",
  generateTimeoutMs: 90000,
};

const cfgPath = () => path.join(app.getPath("userData"), "config.json");
const loadConfig = () => {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(cfgPath(), "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
};
function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
  fs.writeFileSync(cfgPath(), JSON.stringify(next, null, 2));
  return next;
}

let cfg = loadConfig();
const appOrigin = () => (cfg.appUrl ? new URL(cfg.appUrl).origin : "");
const deployBase = () => (app.isPackaged ? path.join(process.resourcesPath, "deploy") : path.join(__dirname, ".."));

// Seule la page du NAS peut utiliser le pont IA
function assertTrusted(event) {
  const url = event.senderFrame?.url || "";
  const o = appOrigin();
  if (!o || !url.startsWith(o)) throw new Error("Origine non autorisée");
}
// Seule la page locale setup.html peut piloter l'installation
function assertSetupPage(event) {
  const url = event.senderFrame?.url || "";
  if (!url.startsWith("file://") || !url.endsWith("setup.html")) throw new Error("Origine non autorisée");
}

/* ---------- Pont IA local (utilisé par la webapp) ---------- */
ipcMain.handle("localai:available", async (event) => {
  assertTrusted(event);
  return ollama.ensureRunning(cfg.ollamaUrl);
});

ipcMain.handle("localai:generate", async (event, { system, user }) => {
  assertTrusted(event);
  if (typeof system !== "string" || typeof user !== "string") throw new Error("Paramètres invalides");
  if (!(await ollama.ensureRunning(cfg.ollamaUrl))) throw new Error("Ollama injoignable");
  const res = await fetch(`${cfg.ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(cfg.generateTimeoutMs),
    body: JSON.stringify({
      model: cfg.ollamaModel,
      stream: false,
      format: "json",
      options: { temperature: 0.7 },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = await res.json();
  return { raw: data.message?.content ?? "", model: cfg.ollamaModel };
});

/* ---------- Assistant d'installation ---------- */
const state = {}; // partagé entre les étapes (modèles Gemini retenus, URL du NAS…)

function wizard(name, fn) {
  ipcMain.handle(`wizard:${name}`, async (event, p = {}) => {
    assertSetupPage(event);
    const log = (l) => event.sender.send("wizard:log", String(l));
    try {
      return { ok: true, ...((await fn(p, log)) || {}) };
    } catch (e) {
      return { ok: false, error: e.message, hint: e instanceof HintError ? e.hint : "" };
    }
  });
}

wizard("ollama", async (_p, log) => {
  if (ollama.resolveBin()) log("Ollama est déjà installé.");
  else await ollama.install(log);
  if (!(await ollama.ensureRunning(cfg.ollamaUrl))) {
    throw new HintError("Ollama est installé mais ne démarre pas.", "Redémarre le PC puis relance l'assistant.");
  }
  return { detail: "Ollama prêt" };
});

wizard("model", async (p, log) => {
  const model = (p.model || cfg.ollamaModel).trim();
  if (!(await ollama.ensureRunning(cfg.ollamaUrl))) throw new HintError("Ollama ne répond pas.", "Relance l'étape précédente.");
  await ollama.pullModel(cfg.ollamaUrl, model, log);
  cfg = saveConfig({ ollamaModel: model });
  return { detail: `${model} téléchargé` };
});

wizard("gpu", async (_p, log) => {
  const model = cfg.ollamaModel;
  log("Test de génération et mesure de l'occupation du GPU…");
  let r = await ollama.gpuCheck(cfg.ollamaUrl, model);
  if (r.pct < 90) {
    log(`Seulement ${r.pct}% sur GPU → activation de Vulkan et redémarrage d'Ollama…`);
    await ollama.enableVulkan(cfg.ollamaUrl);
    r = await ollama.gpuCheck(cfg.ollamaUrl, model);
  }
  if (r.pct < 90) {
    return {
      detail: `GPU ${r.pct}%`,
      warn: "Le modèle tourne surtout sur le processeur (lent). Mets à jour le pilote AMD Adrenalin puis relance l'assistant.",
    };
  }
  return { detail: `${r.pct}% sur GPU (modèle de ${r.gb} Go)` };
});

wizard("gemini", async (p, log) => {
  if (!p.geminiKey) throw new HintError("Clé Gemini manquante.", "Crée-la sur https://aistudio.google.com/apikey");
  log("Vérification de la clé et des modèles…");
  const r = await gemini.test(p.geminiKey.trim(), "gemini-pro-latest", "gemini-flash-latest");
  if (!r.keyOk) {
    throw new HintError(`Clé refusée par Google (${r.status}).`, "Recrée une clé sur https://aistudio.google.com/apikey et recolle-la.");
  }
  if (!r.pro && !r.flash) {
    throw new HintError("Aucun modèle Gemini utilisable avec cette clé.", r.proMsg);
  }
  state.gemini = { key: p.geminiKey.trim(), model: r.pro || r.flash, fallback: r.flash || r.pro };
  if (!r.pro) {
    return {
      detail: `Flash : ${r.flash}`,
      warn: `Pro indisponible avec cette clé (${r.proMsg}). Active la facturation à l'usage dans AI Studio pour l'utiliser ; en attendant l'app utilise Flash.`,
    };
  }
  return { detail: `Pro : ${r.pro}${r.flash ? ` · repli ${r.flash}` : ""}` };
});

wizard("nas", async (p, log) => {
  if (!state.gemini) throw new HintError("Étape Gemini non validée.", "Relance l'étape Gemini.");
  const res = await nas.deploy({
    host: p.nasHost.trim(),
    username: p.sshUser.trim(),
    password: p.sshPass,
    baseDir: deployBase(),
    gemini: state.gemini,
    log,
  });
  state.appUrl = res.appUrl;
  state.token = res.token;
  return { detail: res.appUrl };
});

wizard("finish", async () => {
  if (!state.appUrl) throw new HintError("Le serveur n'a pas été déployé.", "Relance l'étape NAS.");
  const enc = safeStorage.isEncryptionAvailable()
    ? { apiTokenEnc: safeStorage.encryptString(state.token).toString("base64") }
    : { apiToken: state.token };
  cfg = saveConfig({ appUrl: state.appUrl, ...enc });
  return { detail: "Configuration enregistrée" };
});

ipcMain.handle("wizard:get", (event) => {
  assertSetupPage(event);
  return { ollamaModel: cfg.ollamaModel, appUrl: cfg.appUrl };
});

/* ---------- Fenêtre ---------- */
function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: "#0b0b0f",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const showSetup = () => win.loadFile(path.join(__dirname, "setup.html"));
  if (!cfg.appUrl) showSetup();
  else win.loadURL(cfg.appUrl);

  // NAS éteint ou injoignable → retour à l'assistant
  win.webContents.on("did-fail-load", (_e, code, _d, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && url.startsWith("http")) showSetup();
  });

  ipcMain.removeHandler("wizard:done");
  ipcMain.handle("wizard:done", (event) => {
    assertSetupPage(event);
    win.loadURL(cfg.appUrl);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file://") && !url.startsWith(appOrigin())) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
