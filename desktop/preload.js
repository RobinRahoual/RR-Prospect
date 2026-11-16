const { contextBridge, ipcRenderer } = require("electron");

// Le front détecte window.localAI pour passer en mode "auto" (local d'abord, repli Gemini)
contextBridge.exposeInMainWorld("localAI", {
  isAvailable: () => ipcRenderer.invoke("localai:available"),
  generate: (system, user) => ipcRenderer.invoke("localai:generate", { system, user }),
});

// Utilisé uniquement par setup.html (le processus principal refuse tout autre appelant)
contextBridge.exposeInMainWorld("rrSetup", {
  get: () => ipcRenderer.invoke("wizard:get"),
  step: (name, params) => ipcRenderer.invoke(`wizard:${name}`, params),
  done: () => ipcRenderer.invoke("wizard:done"),
  onLog: (cb) => ipcRenderer.on("wizard:log", (_e, line) => cb(line)),
});
