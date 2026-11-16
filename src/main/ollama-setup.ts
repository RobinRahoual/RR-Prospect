// Installation et pilotage d'Ollama sur Windows (processus principal uniquement).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HintError } from "../core/errors";

const INSTALLER_URL = "https://ollama.com/download/OllamaSetup.exe";

export function resolveBin(): string | null {
  const local = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Ollama", "ollama.exe");
  if (local && fs.existsSync(local)) return local;
  try {
    return spawnSync("ollama", ["--version"], { windowsHide: true }).status === 0 ? "ollama" : null;
  } catch {
    return null;
  }
}

export async function isUp(url: string, ms = 1500): Promise<boolean> {
  try {
    return (await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(ms) })).ok;
  } catch {
    return false;
  }
}

/** Démarre `ollama serve` s'il est fermé. */
export async function ensureRunning(url: string, waitS = 15): Promise<boolean> {
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

function runLogged(cmd: string, args: string[], log: (l: string) => void): Promise<number> {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(cmd, args, { windowsHide: true });
    } catch {
      return resolve(-1);
    }
    const feed = (d: Buffer) =>
      d.toString().split(/\r?\n/).map((s) => s.trim()).filter(Boolean).forEach(log);
    p.stdout.on("data", feed);
    p.stderr.on("data", feed);
    p.on("error", () => resolve(-1));
    p.on("close", (code) => resolve(code ?? -1));
  });
}

/** 1) installeur officiel en silencieux  2) winget en secours */
export async function installOllama(log: (l: string) => void): Promise<void> {
  const tmp = path.join(os.tmpdir(), "OllamaSetup.exe");
  try {
    log("Téléchargement de l'installeur Ollama…");
    const res = await fetch(INSTALLER_URL, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    log("Installation silencieuse d'Ollama…");
    await runLogged(tmp, ["/SILENT", "/NORESTART"], log);
  } catch (e) {
    log(`Installeur direct impossible (${(e as Error).message}), essai via winget…`);
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

/** Bascule Ollama sur Vulkan (RX 9000 non listées en ROCm sous Windows) et le redémarre. */
export async function enableVulkan(url: string): Promise<boolean> {
  spawnSync("setx", ["OLLAMA_VULKAN", "1"], { windowsHide: true });
  process.env.OLLAMA_VULKAN = "1";
  for (const img of ["ollama app.exe", "ollama.exe"]) spawnSync("taskkill", ["/F", "/IM", img], { windowsHide: true });
  await new Promise((r) => setTimeout(r, 2500));
  return ensureRunning(url);
}
