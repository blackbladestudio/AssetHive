const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('megascans', {
  progress: () => ipcRenderer.invoke('megascans-monitor:progress'),
  start: options => ipcRenderer.invoke('megascans-monitor:start', options),
  configuration: () => ipcRenderer.invoke('megascans-monitor:configuration'),
  login: () => ipcRenderer.invoke('megascans-monitor:login'),
  pause: () => ipcRenderer.invoke('megascans-monitor:pause'),
  assets: options => ipcRenderer.invoke('megascans-monitor:assets', options),
  open: id => ipcRenderer.invoke('megascans-monitor:open', id)
});
