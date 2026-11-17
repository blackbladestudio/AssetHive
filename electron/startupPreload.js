const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("startup", {
  close: () => ipcRenderer.send("startup:cancel")
});
