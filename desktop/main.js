// Enveloppe Windows : charge la webapp du NAS et expose un pont Ollama local (window.localAI).
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS = {
  appUrl: "",
  ollamaUrl: "http://127.0.0.1:11434",
  ollamaModel: "mistral-nemo",
  generateTimeoutMs: 90000,
};

const cfgPath = () => path.join(app.getPath("userData"), "config.json");

function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(cfgPath(), "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
  fs.writeFileSync(cfgPath(), JSON.stringify(next, null, 2));
  return next;
}

let cfg = loadConfig();
const appOrigin = () => (cfg.appUrl ? new URL(cfg.appUrl).origin : "");

async function ollamaUp(timeoutMs = 1500) {
  try {
    const r = await fetch(`${cfg.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

// Démarre `ollama serve` s'il est fermé (Ollama doit être installé et dans le PATH)
async function ensureOllama() {
  if (await ollamaUp()) return true;
  try {
    spawn("ollama", ["serve"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {
    return false;
  }
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await ollamaUp()) return true;
  }
  return false;
}

// Seule la page du NAS peut utiliser le pont IA
function assertTrusted(event) {
  const url = event.senderFrame?.url || "";
  const o = appOrigin();
  if (!o || !url.startsWith(o)) throw new Error("Origine non autorisée");
}

// Seule la page locale setup.html peut modifier la configuration
function assertSetupPage(event) {
  const url = event.senderFrame?.url || "";
  if (!url.startsWith("file://") || !url.endsWith("setup.html")) throw new Error("Origine non autorisée");
}

ipcMain.handle("localai:available", async (event) => {
  assertTrusted(event);
  return ensureOllama();
});

ipcMain.handle("localai:generate", async (event, { system, user }) => {
  assertTrusted(event);
  if (typeof system !== "string" || typeof user !== "string") throw new Error("Paramètres invalides");
  if (!(await ensureOllama())) throw new Error("Ollama injoignable");
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

ipcMain.handle("setup:get", (event) => {
  assertSetupPage(event);
  return cfg;
});

ipcMain.handle("setup:save", (event, { appUrl, ollamaModel }) => {
  assertSetupPage(event);
  const u = new URL(appUrl); // lève une erreur si l'URL est invalide
  if (!/^https?:$/.test(u.protocol)) throw new Error("URL http(s) requise");
  cfg = saveConfig({ appUrl: u.origin + (u.pathname === "/" ? "" : u.pathname), ollamaModel: String(ollamaModel || "mistral-nemo") });
  return true;
});

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

  // NAS éteint ou URL erronée → retour à l'écran de configuration
  win.webContents.on("did-fail-load", (_e, code, _desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && url.startsWith("http")) showSetup();
  });

  // Une fois la config enregistrée, setup.html demande le rechargement
  ipcMain.removeHandler("setup:done");
  ipcMain.handle("setup:done", (event) => {
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
