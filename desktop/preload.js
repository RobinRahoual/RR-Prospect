const { contextBridge, ipcRenderer } = require("electron");

// Le front détecte window.localAI pour passer en mode "auto" (local d'abord, repli Gemini)
contextBridge.exposeInMainWorld("localAI", {
  isAvailable: () => ipcRenderer.invoke("localai:available"),
  generate: (system, user) => ipcRenderer.invoke("localai:generate", { system, user }),
});

// Utilisé uniquement par setup.html (le processus principal refuse tout autre appelant)
contextBridge.exposeInMainWorld("rrSetup", {
  get: () => ipcRenderer.invoke("setup:get"),
  save: (cfg) => ipcRenderer.invoke("setup:save", cfg),
  done: () => ipcRenderer.invoke("setup:done"),
});
