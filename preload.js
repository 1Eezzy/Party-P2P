const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  start: o => ipcRenderer.invoke('party:start', o),
  stop: () => ipcRenderer.invoke('party:stop'),
  party: {
    members: () => ipcRenderer.invoke('party:members'),
    memberAction: (action, key) => ipcRenderer.invoke('party:member-action', { action, key }),
    memberPermission: (key, role) => ipcRenderer.invoke('party:member-permission', { key, role }),
    channels: () => ipcRenderer.invoke('party:channels'),
    updateChannel: (id, changes) => ipcRenderer.invoke('party:channel-update', { id, changes }),
    removeChannel: id => ipcRenderer.invoke('party:channel-remove', id),
  },
  window: {
    maximizeForFloating: () => ipcRenderer.invoke('window:maximize-for-floating'),
    restoreAfterFloating: () => ipcRenderer.invoke('window:restore-after-floating'),
  },
  sources: () => ipcRenderer.invoke('screen:sources'),
  pick: source => ipcRenderer.invoke('screen:pick', source),
  persistence: {
    load: () => ipcRenderer.invoke('persistence:load'),
    saveProfile: profile => ipcRenderer.invoke('persistence:profile', profile),
    syncHistory: history => ipcRenderer.invoke('persistence:history:sync', history),
    saveHistory: history => ipcRenderer.invoke('persistence:history', history),
    saveRecent: party => ipcRenderer.invoke('persistence:recent', party),
  },
  profile: {
    photo: () => ipcRenderer.invoke('profile:photo'),
    choosePhoto: () => ipcRenderer.invoke('profile:photo:choose'),
    removePhoto: () => ipcRenderer.invoke('profile:photo:remove'),
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
  },
  app: {
    version: () => ipcRenderer.invoke('app:version'),
  },
});
