import { app, type WebContents } from "electron";
import { autoUpdater } from "electron-updater";

import type { UpdateState } from "../shared/ipc";

let current: UpdateState = { state: "idle", version: app.getVersion() };
let target: WebContents | null = null;

const set = (s: UpdateState) => {
  current = s;
  if (target && !target.isDestroyed()) target.send("update:state", s);
};

export const updateState = () => current;

/** Mises à jour automatiques depuis les Releases GitHub (ne fait rien en développement). */
export function initUpdater(wc: WebContents): void {
  target = wc;
  if (!app.isPackaged) return set({ state: "unavailable", version: app.getVersion() });

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // installe à la fermeture si Robin ne clique pas
  autoUpdater.on("checking-for-update", () => set({ state: "checking", version: app.getVersion() }));
  autoUpdater.on("update-not-available", () => set({ state: "uptodate", version: app.getVersion() }));
  autoUpdater.on("download-progress", (p) => set({ state: "downloading", version: app.getVersion(), percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (i) => set({ state: "ready", version: app.getVersion(), next: i.version }));
  // Réseau coupé, dépôt privé, etc. : on reste silencieux, l'app continue de fonctionner
  autoUpdater.on("error", () => set({ state: "unavailable", version: app.getVersion() }));

  const check = () => void autoUpdater.checkForUpdates().catch(() => undefined);
  setTimeout(check, 5_000);
  setInterval(check, 6 * 3600_000);
}

export function checkNow(): void {
  if (app.isPackaged) void autoUpdater.checkForUpdates().catch(() => undefined);
}

export function installNow(): void {
  if (current.state === "ready") autoUpdater.quitAndInstall(false, true);
}
