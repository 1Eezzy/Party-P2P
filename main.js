const { app, BrowserWindow, ipcMain, session, desktopCapturer } = require('electron');
const os = require('os');
const path = require('path');
const { startServer } = require('./server');

let srv = null;
const stop = () => { srv?.close(); srv = null; };

ipcMain.handle('party:start', async (_, o) => {
  stop();
  try {
    srv = await startServer({ port: Number(o.port) || 7777, name: o.name, password: o.password });
    const ips = Object.entries(os.networkInterfaces()).flatMap(([name, list]) =>
      list.filter(a => a.family === 'IPv4' && !a.internal).map(a => ({ name, ip: a.address })));
    return { ok: true, ips };
  } catch (e) {
    return { ok: false, error: e.code === 'EADDRINUSE' ? 'Essa porta já está em uso.' : e.message };
  }
});
ipcMain.handle('party:stop', () => stop());

// Compartilhamento de tela: o app lista as telas/janelas, a pessoa escolhe e o id fica guardado
// até o getDisplayMedia() do renderer pedir a captura.
let chosen = null;
ipcMain.handle('screen:sources', async () =>
  (await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } }))
    .map(s => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() })));
ipcMain.handle('screen:pick', (_, id) => { chosen = id; });

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_, perm, cb) =>
    cb(['media', 'display-capture', 'clipboard-sanitized-write'].includes(perm)));
  session.defaultSession.setDisplayMediaRequestHandler((_, cb) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then(list => {
      const video = list.find(s => s.id === chosen); chosen = null;
      cb(video ? { video } : {});
    }, () => cb({}));
  });
  const win = new BrowserWindow({
    width: 1120, height: 720, minWidth: 820, minHeight: 520,
    backgroundColor: '#1a1d33', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile('index.html');
});

app.on('window-all-closed', () => { stop(); app.quit(); });
