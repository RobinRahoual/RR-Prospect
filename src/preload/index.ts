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
    analyze: (id) => ipcRenderer.invoke("leads:analyze", id),
  },
  scan: {
    getSettings: () => ipcRenderer.invoke("scan:get"),
    setSettings: (s) => ipcRenderer.invoke("scan:set", s),
    geocode: (q) => ipcRenderer.invoke("scan:geocode", q),
    run: () => ipcRenderer.invoke("scan:run"),
    hasOaKey: () => ipcRenderer.invoke("scan:hasOaKey"),
    setOaKey: (k) => ipcRenderer.invoke("scan:setOaKey", k),
    onLog: (cb) => {
      ipcRenderer.removeAllListeners("scan:log");
      ipcRenderer.on("scan:log", (_e, l: string) => cb(l));
    },
  },
  chat: {
    list: () => ipcRenderer.invoke("chat:list"),
    create: () => ipcRenderer.invoke("chat:create"),
    messages: (id) => ipcRenderer.invoke("chat:messages", id),
    send: (id, text) => ipcRenderer.invoke("chat:send", id, text),
    remove: (id) => ipcRenderer.invoke("chat:remove", id),
    onMessage: (cb) => {
      ipcRenderer.removeAllListeners("chat:message");
      ipcRenderer.on("chat:message", (_e, m) => cb(m));
    },
  },
  drafts: {
    list: (leadId) => ipcRenderer.invoke("drafts:list", leadId),
    generate: (leadId, mode) => ipcRenderer.invoke("drafts:generate", leadId, mode),
    update: (id, patch) => ipcRenderer.invoke("drafts:update", id, patch),
  },
};

contextBridge.exposeInMainWorld("api", api);
