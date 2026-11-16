import { contextBridge, ipcRenderer } from "electron";
import type { Api } from "../shared/ipc";

const api: Api = {
  config: {
    get: () => ipcRenderer.invoke("config:get"),
    setMode: (mode) => ipcRenderer.invoke("config:setMode", mode),
  },
  setup: {
    step: (name, params) => ipcRenderer.invoke("setup:step", name, params),
    finish: () => ipcRenderer.invoke("setup:finish"),
    onLog: (cb) => {
      ipcRenderer.removeAllListeners("setup:log"); // évite les doublons (rendu React en mode strict)
      ipcRenderer.on("setup:log", (_e, line: string) => cb(line));
    },
  },
  leads: {
    list: () => ipcRenderer.invoke("leads:list"),
    create: (input) => ipcRenderer.invoke("leads:create", input),
  },
  drafts: {
    list: (leadId) => ipcRenderer.invoke("drafts:list", leadId),
    generate: (leadId, mode) => ipcRenderer.invoke("drafts:generate", leadId, mode),
    update: (id, patch) => ipcRenderer.invoke("drafts:update", id, patch),
  },
};

contextBridge.exposeInMainWorld("api", api);
