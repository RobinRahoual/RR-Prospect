import { contextBridge, ipcRenderer } from "electron";
import type { Api } from "../shared/ipc";

const syncCbs = new Set<(r: { pulled: number; pushed: number; error?: string }) => void>();
ipcRenderer.on("sync:done", (_e, r) => syncCbs.forEach((cb) => cb(r)));

const api: Api = {
  sync: {
    get: () => ipcRenderer.invoke("sync:get"),
    set: (cfg, pass) => ipcRenderer.invoke("sync:set", cfg, pass),
    run: () => ipcRenderer.invoke("sync:run"),
    disable: () => ipcRenderer.invoke("sync:disable"),
    onDone: (cb) => {
      syncCbs.add(cb);
    },
  },
  inbox: {
    check: () => ipcRenderer.invoke("inbox:check"),
    list: () => ipcRenderer.invoke("inbox:list"),
    onNew: (cb) => {
      ipcRenderer.removeAllListeners("inbox:new");
      ipcRenderer.on("inbox:new", (_e, r) => cb(r));
    },
  },
  track: {
    get: () => ipcRenderer.invoke("track:get"),
    install: (token) => ipcRenderer.invoke("track:install", token),
    disable: () => ipcRenderer.invoke("track:disable"),
    refresh: () => ipcRenderer.invoke("track:refresh"),
    opens: () => ipcRenderer.invoke("track:opens"),
    onLog: (cb) => {
      ipcRenderer.removeAllListeners("track:log");
      ipcRenderer.on("track:log", (_e, l) => cb(l));
    },
  },
  mail: {
    get: () => ipcRenderer.invoke("mail:get"),
    set: (settings, pass) => ipcRenderer.invoke("mail:set", settings, pass),
    test: () => ipcRenderer.invoke("mail:test"),
    send: (id) => ipcRenderer.invoke("mail:send", id),
    sendApproved: () => ipcRenderer.invoke("mail:sendApproved"),
    cancel: () => ipcRenderer.invoke("mail:cancel"),
    onProgress: (cb) => {
      ipcRenderer.removeAllListeners("mail:progress");
      ipcRenderer.on("mail:progress", (_e, p) => cb(p));
    },
  },
  update: {
    state: () => ipcRenderer.invoke("update:state"),
    check: () => ipcRenderer.invoke("update:check"),
    install: () => ipcRenderer.invoke("update:install"),
    onState: (cb) => {
      ipcRenderer.removeAllListeners("update:state");
      ipcRenderer.on("update:state", (_e, s) => cb(s));
    },
  },
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
    get: (id) => ipcRenderer.invoke("leads:get", id),
    suppress: (id) => ipcRenderer.invoke("leads:suppress", id),
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
