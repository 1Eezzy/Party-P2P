const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  start: o => ipcRenderer.invoke('party:start', o),
  stop: () => ipcRenderer.invoke('party:stop'),
  sources: () => ipcRenderer.invoke('screen:sources'),
  pick: id => ipcRenderer.invoke('screen:pick', id),
});
