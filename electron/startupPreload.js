const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("startup", {
  minimize: () => ipcRenderer.send("startup:minimize"),
  close: () => ipcRenderer.send("startup:cancel"),
  onLanguageChange: (callback) => {
    ipcRenderer.on("startup:language", (_event, language) => callback(language));
  }
});
