const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { HintError } = require("./errors");

const INSTALLER_URL = "https://ollama.com/download/OllamaSetup.exe";

function resolveBin() {
  const local = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Ollama", "ollama.exe");
  if (local && fs.existsSync(local)) return local;
  try {
    const r = spawnSync("ollama", ["--version"], { windowsHide: true });
    return r.status === 0 ? "ollama" : null;
  } catch {
    return null;
  }
}

async function isUp(url, ms = 1500) {
  try {
    const r = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(ms) });
    return r.ok;
  } catch {
    return false;
  }
}

// Démarre `ollama serve` s'il est fermé
async function ensureRunning(url, waitS = 15) {
  if (await isUp(url)) return true;
  const bin = resolveBin();
  if (!bin) return false;
  try {
    spawn(bin, ["serve"], { detached: true, stdio: "ignore", windowsHide: true, env: process.env }).unref();
  } catch {
    return false;
  }
  for (let i = 0; i < waitS; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await isUp(url)) return true;
  }
  return false;
}

function runLogged(cmd, args, log) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(cmd, args, { windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, error: e });
    }
    const feed = (d) => d.toString().split(/\r?\n/).map((s) => s.trim()).filter(Boolean).forEach(log);
    p.stdout.on("data", feed);
    p.stderr.on("data", feed);
    p.on("error", (error) => resolve({ code: -1, error }));
    p.on("close", (code) => resolve({ code }));
  });
}

// 1) installeur officiel en mode silencieux  2) winget en secours
async function install(log) {
  const tmp = path.join(os.tmpdir(), "OllamaSetup.exe");
  try {
    log("Téléchargement de l'installeur Ollama…");
    const res = await fetch(INSTALLER_URL, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    log("Installation silencieuse d'Ollama…");
    await runLogged(tmp, ["/SILENT", "/NORESTART"], log);
  } catch (e) {
    log(`Installeur direct impossible (${e.message}), essai via winget…`);
    await runLogged(
      "winget",
      ["install", "-e", "--id", "Ollama.Ollama", "--silent", "--accept-package-agreements", "--accept-source-agreements"],
      log
    );
  }
  for (let i = 0; i < 20 && !resolveBin(); i++) await new Promise((r) => setTimeout(r, 1000));
  if (!resolveBin()) {
    throw new HintError(
      "Ollama n'a pas pu être installé automatiquement.",
      "Installe-le à la main depuis https://ollama.com/download/windows puis clique sur « Réessayer »."
    );
  }
}

async function pullModel(url, model, log) {
  const res = await fetch(`${url}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: true }),
  });
  if (!res.ok) throw new HintError(`Téléchargement du modèle refusé (HTTP ${res.status})`, `Vérifie le nom du modèle : ${model}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let lastPct = -10;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      if (j.error) throw new HintError(`Ollama : ${j.error}`, "Vérifie le nom du modèle et ta connexion internet.");
      if (j.total && j.completed) {
        const pct = Math.floor((j.completed / j.total) * 100);
        if (pct >= lastPct + 5) {
          lastPct = pct;
          log(`${j.status} ${pct}%`);
        }
      } else if (j.status) log(j.status);
    }
  }
}

// Génère un mot puis lit /api/ps : part du modèle chargée en VRAM
async function gpuCheck(url, model) {
  const g = await fetch(`${url}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(180000),
    body: JSON.stringify({ model, prompt: "Réponds : OK", stream: false, keep_alive: "2m", options: { num_predict: 8 } }),
  });
  if (!g.ok) throw new HintError(`Le modèle ne répond pas (HTTP ${g.status})`, "Relance l'assistant ; si ça persiste, redémarre Ollama.");
  const ps = await (await fetch(`${url}/api/ps`)).json();
  const m = (ps.models || []).find((x) => x.name === model || x.model === model || x.name?.startsWith(model));
  if (!m || !m.size) return { pct: 0, gb: 0 };
  return { pct: Math.round((m.size_vram / m.size) * 100), gb: +(m.size / 1e9).toFixed(1) };
}

// Bascule Ollama sur Vulkan (RX 9000 non listées en ROCm sous Windows) et le redémarre
async function enableVulkan(url) {
  spawnSync("setx", ["OLLAMA_VULKAN", "1"], { windowsHide: true });
  process.env.OLLAMA_VULKAN = "1";
  for (const img of ["ollama app.exe", "ollama.exe"]) spawnSync("taskkill", ["/F", "/IM", img], { windowsHide: true });
  await new Promise((r) => setTimeout(r, 2500));
  return ensureRunning(url);
}

module.exports = { resolveBin, isUp, ensureRunning, install, pullModel, gpuCheck, enableVulkan };
