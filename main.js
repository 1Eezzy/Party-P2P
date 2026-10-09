const { app, BrowserWindow, ipcMain, session, desktopCapturer } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { startServer } = require('./server');
const partyStore = require('./party-store');

let srv = null;
let pendingUpdate = null;
let downloadedUpdate = null;
const REPOSITORY = '1Eezzy/Party-P2P';
const stop = () => { srv?.close(); srv = null; };

const versionParts = version => String(version).replace(/^v/i, '').split(/[-+]/)[0]
  .split('.').map(part => Number.parseInt(part, 10) || 0);
function isNewerVersion(candidate, current = app.getVersion()) {
  const next = versionParts(candidate), installed = versionParts(current);
  const length = Math.max(next.length, installed.length);
  for (let i = 0; i < length; i++) {
    if ((next[i] || 0) !== (installed[i] || 0)) return (next[i] || 0) > (installed[i] || 0);
  }
  return false;
}

function request(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Muitos redirecionamentos ao consultar a atualização.'));
    const req = https.get(url, { headers: { 'User-Agent': 'Party-P2P-Updater', Accept: 'application/vnd.github+json' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return request(new URL(res.headers.location, url), redirects + 1).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => res.statusCode === 200
        ? resolve(Buffer.concat(chunks))
        : reject(new Error(`GitHub respondeu com status ${res.statusCode}.`)));
    });
    req.setTimeout(15000, () => req.destroy(new Error('Tempo esgotado ao consultar o GitHub.')));
    req.on('error', reject);
  });
}

function download(url, file, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Muitos redirecionamentos ao baixar a atualização.'));
    const req = https.get(url, { headers: { 'User-Agent': 'Party-P2P-Updater' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(new URL(res.headers.location, url), file, onProgress, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Download indisponível (status ${res.statusCode}).`));
      }
      const total = Number(res.headers['content-length']) || 0;
      let received = 0;
      res.on('data', chunk => {
        received += chunk.length;
        onProgress?.({ received, total, percent: total ? Math.floor(received * 100 / total) : null });
      });
      const output = fs.createWriteStream(file);
      res.pipe(output);
      output.on('finish', () => output.close(resolve));
      output.on('error', error => { output.destroy(); fs.rm(file, { force: true }, () => reject(error)); });
    });
    req.setTimeout(120000, () => req.destroy(new Error('Tempo esgotado ao baixar a atualização.')));
    req.on('error', error => fs.rm(file, { force: true }, () => reject(error)));
  });
}

function selectAsset(release) {
  const executables = (release.assets || []).filter(asset => /\.exe$/i.test(asset.name));
  const portable = !!process.env.PORTABLE_EXECUTABLE_DIR;
  const installer = executables.find(asset => /(?:^|[ ._-])setup(?:[ ._-]|$)/i.test(asset.name));
  const standalone = executables.find(asset => !/(?:^|[ ._-])setup(?:[ ._-]|$)/i.test(asset.name));
  return portable ? standalone || installer : installer;
}

async function checkForUpdate() {
  const release = JSON.parse((await request(`https://api.github.com/repos/${REPOSITORY}/releases/latest`)).toString('utf8'));
  if (release.draft || release.prerelease || !isNewerVersion(release.tag_name))
    return { status: 'current', version: app.getVersion() };
  const asset = selectAsset(release);
  if (!asset?.browser_download_url)
    return { status: 'unsupported', message: 'A release mais recente não contém o executável adequado.' };
  pendingUpdate = { version: String(release.tag_name).replace(/^v/i, ''), asset };
  return { status: 'available', version: pendingUpdate.version };
}

async function downloadUpdate(onProgress) {
  if (!pendingUpdate) {
    const result = await checkForUpdate();
    if (result.status !== 'available') return result;
  }
  const safeName = pendingUpdate.asset.name.replace(/[^a-z0-9._ -]/gi, '_');
  const file = path.join(app.getPath('temp'), `Party-P2P-update-${pendingUpdate.version}-${safeName}`);
  await fs.promises.rm(file, { force: true });
  await download(pendingUpdate.asset.browser_download_url, file, onProgress);
  downloadedUpdate = { ...pendingUpdate, file, portable: !!process.env.PORTABLE_EXECUTABLE_DIR };
  return { status: 'downloaded', version: downloadedUpdate.version };
}

function installUpdate() {
  if (!downloadedUpdate) return { status: 'error', message: 'Nenhuma atualização foi baixada.' };
  const stopOldProcess = `taskkill /PID ${process.pid} /F > nul 2>&1`;
  const command = downloadedUpdate.portable
    ? `timeout /t 1 /nobreak > nul & ${stopOldProcess} & timeout /t 1 /nobreak > nul & for /L %i in (1,1,10) do @(move /y "${downloadedUpdate.file}" "${process.execPath}" > nul 2>&1 && (start "" "${process.execPath}" & exit /b) || timeout /t 1 /nobreak > nul)`
    : `timeout /t 1 /nobreak > nul & ${stopOldProcess} & timeout /t 1 /nobreak > nul & start "" /wait "${downloadedUpdate.file}" /S & start "" "${process.execPath}"`;
  const helper = spawn('cmd.exe', ['/d', '/s', '/c', command], { detached: true, stdio: 'ignore', windowsHide: true });
  helper.unref();
  setTimeout(() => app.quit(), 350);
  return { status: 'installing' };
}

ipcMain.handle('party:start', async (_, o) => {
  stop();
  try {
    const port = Number(o.port) || 7777;
    const saved = partyStore.beginParty({ port, name: o.name, password: o.password });
    srv = await startServer({
      port, name: o.name, password: o.password, channels: saved.channels,
      onChannelsChange: channels => partyStore.saveChannels(channels),
    });
    const ips = Object.entries(os.networkInterfaces()).flatMap(([name, list]) =>
      list.filter(a => a.family === 'IPv4' && !a.internal).map(a => ({ name, ip: a.address })));
    return { ok: true, ips, history: saved.history };
  } catch (e) {
    return { ok: false, error: e.code === 'EADDRINUSE' ? 'Essa porta já está em uso.' : e.message };
  }
});
ipcMain.handle('party:stop', () => stop());
ipcMain.handle('persistence:load', () => partyStore.snapshot());
ipcMain.handle('persistence:profile', (_, profile) => partyStore.saveProfile(profile));
ipcMain.handle('persistence:history', (_, history) => partyStore.saveHistory(history));
ipcMain.handle('persistence:recent', (_, party) => partyStore.saveRecent(party));
ipcMain.handle('update:check', async () => {
  try { return await checkForUpdate(); }
  catch (error) { return { status: 'error', message: error.message }; }
});
ipcMain.handle('update:download', async event => {
  try { return await downloadUpdate(progress => event.sender.send('update:progress', progress)); }
  catch (error) { return { status: 'error', message: error.message }; }
});
ipcMain.handle('update:install', () => installUpdate());

// Compartilhamento de tela: o app lista as telas/janelas, a pessoa escolhe e o id fica guardado
// até o getDisplayMedia() do renderer pedir a captura.
let chosen = null;
ipcMain.handle('screen:sources', async () =>
  (await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } }))
    .map(s => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() })));
ipcMain.handle('screen:pick', (_, source) => {
  const id = typeof source === 'string' ? source : source?.id;
  chosen = id ? { id, audio: !!source?.audio } : null;
});

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_, perm, cb) =>
    cb(['media', 'display-capture', 'clipboard-sanitized-write'].includes(perm)));
  session.defaultSession.setDisplayMediaRequestHandler((_, cb) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then(list => {
      const request = chosen; chosen = null;
      const video = list.find(s => s.id === request?.id);
      // O loopback fornece o áudio reproduzido pelo sistema junto da tela no Windows.
      cb(video ? (request.audio ? { video, audio: 'loopback' } : { video }) : {});
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
