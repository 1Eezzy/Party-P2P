const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  start: o => ipcRenderer.invoke('party:start', o),
  stop: () => ipcRenderer.invoke('party:stop'),
  sources: () => ipcRenderer.invoke('screen:sources'),
  pick: source => ipcRenderer.invoke('screen:pick', source),
  persistence: {
    load: () => ipcRenderer.invoke('persistence:load'),
    saveProfile: profile => ipcRenderer.invoke('persistence:profile', profile),
    saveHistory: history => ipcRenderer.invoke('persistence:history', history),
    saveRecent: party => ipcRenderer.invoke('persistence:recent', party),
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    onProgress: callback => {
      const listener = (_, progress) => callback(progress);
      ipcRenderer.on('update:progress', listener);
      return () => ipcRenderer.removeListener('update:progress', listener);
    },
  },
});
