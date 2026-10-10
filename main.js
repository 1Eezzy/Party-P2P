const { app, BrowserWindow, ipcMain, session, desktopCapturer, dialog } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { startServer } = require('./server');

// Mantém o mesmo armazenamento no `electron .` e no executável empacotado.
const USER_DATA_NAME = 'Party P2P';
const STATE_FILE = 'party-p2p.json';
function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}
function uniqueBy(items, key) {
  const map = new Map();
  items.filter(Boolean).forEach(item => map.set(key(item), item));
  return [...map.values()];
}
function mergeConversations(older, newer) {
  const conversations = new Map();
  for (const conversation of [...(Array.isArray(older) ? older : []), ...(Array.isArray(newer) ? newer : [])]) {
    if (!conversation?.id) continue;
    const current = conversations.get(conversation.id);
    if (!current) { conversations.set(conversation.id, { ...conversation, msgs: [...(conversation.msgs || [])] }); continue; }
    const messages = uniqueBy([...(current.msgs || []), ...(conversation.msgs || [])], message =>
      `${message.ts || ''}\u0000${message.n || ''}\u0000${message.text || ''}`)
      .sort((a, b) => (a.ts || 0) - (b.ts || 0));
    conversations.set(conversation.id, {
      ...current, ...conversation,
      members: conversation.members?.length ? conversation.members : current.members,
      msgs: messages,
    });
  }
  return [...conversations.values()];
}
function mergeMembers(older, newer) {
  const members = new Map();
  for (const member of [...(Array.isArray(older) ? older : []), ...(Array.isArray(newer) ? newer : [])]) {
    if (!member?.key) continue;
    const current = members.get(member.key);
    members.set(member.key, !current || (member.lastSeen || 0) >= (current.lastSeen || 0) ? member : current);
  }
  return [...members.values()];
}
function mergeLegacyState(legacy, current) {
  if (!current) return legacy;
  if (!legacy) return current;
  const legacyParty = legacy.party, currentParty = current.party;
  const sameParty = legacyParty && currentParty
    && legacyParty.name === currentParty.name && Number(legacyParty.port) === Number(currentParty.port);
  if (!sameParty) return current;
  const recent = uniqueBy([...(legacy.recent || []), ...(current.recent || [])], party => `${party.name}\u0000${party.address}`)
    .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0)).slice(0, 4);
  return {
    ...legacy, ...current,
    profile: { ...(legacy.profile || {}), ...(current.profile || {}) },
    party: {
      ...legacyParty, ...currentParty,
      channels: uniqueBy([...(legacyParty.channels || []), ...(currentParty.channels || [])], channel => channel.id),
      members: mergeMembers(legacyParty.members, currentParty.members),
    },
    history: mergeConversations(legacy.history, current.history),
    recent,
  };
}
function configureUserData() {
  const appData = app.getPath('appData');
  const destination = path.join(appData, USER_DATA_NAME);
  fs.mkdirSync(destination, { recursive: true });
  const targetState = path.join(destination, STATE_FILE);
  for (const legacyName of ['party-p2p']) {
    const legacy = path.join(appData, legacyName);
    const state = path.join(legacy, STATE_FILE);
    if (fs.existsSync(state)) {
      const migrated = mergeLegacyState(readState(state), readState(targetState));
      if (migrated && JSON.stringify(migrated) !== JSON.stringify(readState(targetState)))
        fs.writeFileSync(targetState, JSON.stringify(migrated), 'utf8');
    }
    if (fs.existsSync(legacy)) {
      for (const name of fs.readdirSync(legacy).filter(name => name.startsWith('profile-avatar.'))) {
        const target = path.join(destination, name);
        if (!fs.existsSync(target)) fs.copyFileSync(path.join(legacy, name), target);
      }
    }
  }
  app.setPath('userData', destination);
}
configureUserData();
const partyStore = require('./party-store');

let srv = null;
let pendingUpdate = null;
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

async function waitForFile(file, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { await fs.promises.access(file); return; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  throw new Error('O módulo de atualização não conseguiu abrir. Tente novamente ou execute o Party P2P como administrador.');
}

function updaterFolder() {
  return path.join(app.getPath('userData'), 'updater');
}
async function ensureUpdaterModule() {
  const folder = updaterFolder();
  const executable = path.join(folder, 'PartyP2P.Updater.exe');
  const source = app.isPackaged
    ? path.join(process.resourcesPath, 'updater', 'PartyP2P.Updater.exe')
    : path.join(__dirname, 'build', 'updater', 'PartyP2P.Updater.exe');
  await fs.promises.mkdir(folder, { recursive: true });
  const [packaged, current] = await Promise.all([
    fs.promises.readFile(source),
    fs.promises.readFile(executable).catch(() => null),
  ]);
  if (!current || !current.equals(packaged)) {
    const staged = `${executable}.new`;
    await fs.promises.writeFile(staged, packaged);
    await fs.promises.rm(executable, { force: true });
    await fs.promises.rename(staged, executable);
  }
  // Migração do protótipo em PowerShell; o novo updater é um binário nativo.
  await fs.promises.rm(path.join(folder, 'PartyP2P-Updater.ps1'), { force: true }).catch(() => {});
  return executable;
}
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
function windowsArgument(value) {
  // Start-Process junta arrays sem recolocar aspas. Retornamos uma única linha
  // de comando já escapada para preservar caminhos como "Party P2P".
  return `"${String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/g, '$1$1')}"`;
}

async function launchUpdateHelper() {
  if (!pendingUpdate) {
    const result = await checkForUpdate();
    if (result.status !== 'available') return result;
  }
  if (!app.isPackaged) {
    return { status: 'error', message: 'A instalação pelo atualizador está disponível apenas no executável distribuído.' };
  }

  const folder = updaterFolder();
  const readyPath = path.join(folder, `ready-${process.pid}-${Date.now()}.signal`);
  const portableTarget = process.env.PORTABLE_EXECUTABLE_FILE;
  const targetPath = portableTarget && path.isAbsolute(portableTarget) ? portableTarget : process.execPath;
  let jobPath = '';
  try {
    const updater = await ensureUpdaterModule();
    await fs.promises.rm(readyPath, { force: true });
    jobPath = path.join(folder, `job-${process.pid}-${Date.now()}.json`);
    const job = {
      // O portable do electron-builder executa uma cópia extraída em TEMP.
      // PORTABLE_EXECUTABLE_FILE é o .exe real que o usuário abriu.
      TargetPath: targetPath,
      ParentPid: process.pid,
      DownloadUrl: pendingUpdate.asset.browser_download_url,
      AssetDigest: pendingUpdate.asset.digest || '',
      Version: pendingUpdate.version,
      ReadyPath: readyPath,
      Mode: process.env.PORTABLE_EXECUTABLE_DIR ? 'portable' : 'installer',
    };
    await fs.promises.writeFile(jobPath, JSON.stringify(job), { encoding: 'utf8', mode: 0o600 });
    const commandLine = ['--job', jobPath].map(windowsArgument).join(' ');
    const command = `$ErrorActionPreference = 'Stop'; Start-Process -FilePath ${psQuote(updater)} -ArgumentList ${psQuote(commandLine)} -Verb RunAs -PassThru | Out-Null`;
    await new Promise((resolve, reject) => {
      const launcher = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command,
      ], { windowsHide: true, stdio: 'ignore' });
      launcher.once('error', reject);
      launcher.once('exit', code => code === 0 ? resolve() : reject(new Error('A permissão de administrador foi recusada ou não pôde ser obtida.')));
    });
    // O app só fecha depois que o módulo persistente confirma sua janela.
    await waitForFile(readyPath);
    await fs.promises.rm(readyPath, { force: true });
    setTimeout(() => app.quit(), 200);
    return { status: 'installing', version: pendingUpdate.version };
  } catch (error) {
    await fs.promises.rm(readyPath, { force: true }).catch(() => {});
    if (jobPath) await fs.promises.rm(jobPath, { force: true }).catch(() => {});
    return { status: 'error', message: error.message };
  }
}

ipcMain.handle('party:start', async (_, o) => {
  stop();
  try {
    const port = Number(o.port) || 7777;
    const saved = partyStore.beginParty({ port, name: o.name, password: o.password, ownerDevice: o.ownerDevice });
    srv = await startServer({
      port, name: o.name, password: o.password, channels: saved.channels, memberHistory: saved.members, history: saved.history, ownerDevice: saved.ownerDevice,
      onChannelsChange: channels => partyStore.saveChannels(channels),
      onMembersChange: members => partyStore.saveMembers(members),
    });
    const ips = Object.entries(os.networkInterfaces()).flatMap(([name, list]) =>
      list.filter(a => a.family === 'IPv4' && !a.internal).map(a => ({ name, ip: a.address })));
    return { ok: true, ips, history: saved.history };
  } catch (e) {
    return { ok: false, error: e.code === 'EADDRINUSE' ? 'Essa porta já está em uso.' : e.message };
  }
});
ipcMain.handle('party:stop', () => stop());
ipcMain.handle('party:members', () => srv?.members() || []);
ipcMain.handle('party:member-action', (_, { action, key } = {}) => {
  if (!srv) return { error: 'Nenhuma party está ativa.' };
  const actions = { kick: 'kick', remove: 'remove', ban: 'ban', unban: 'unban' };
  if (!actions[action]) return { error: 'Ação de membro inválida.' };
  return { members: srv[actions[action]](key) };
});
ipcMain.handle('party:member-permission', (_, { key, role } = {}) => {
  if (!srv) return { error: 'Nenhuma party está ativa.' };
  return { members: srv.setRole(key, role) };
});
ipcMain.handle('party:channels', () => srv?.channels() || []);
ipcMain.handle('party:channel-update', (_, { id, changes } = {}) => {
  if (!srv) return { error: 'Nenhuma party está ativa.' };
  const channel = srv.updateChannel(id, changes);
  return channel ? { channel } : { error: 'Canal inválido.' };
});
ipcMain.handle('party:channel-remove', (_, id) => {
  if (!srv) return { error: 'Nenhuma party está ativa.' };
  return srv.removeChannel(id) ? { ok: true } : { error: 'Canal inválido.' };
});
ipcMain.handle('persistence:load', () => partyStore.snapshot());
ipcMain.handle('persistence:profile', (_, profile) => partyStore.saveProfile(profile));
ipcMain.handle('persistence:history:sync', (_, history) => srv?.setHistory(history));
ipcMain.handle('persistence:history', (_, history) => {
  partyStore.saveHistory(history);
  srv?.setHistory(history);
});
ipcMain.handle('persistence:recent', (_, party) => partyStore.saveRecent(party));

const avatarMime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const avatarPath = () => path.join(app.getPath('userData'), path.basename(partyStore.snapshot().profile.avatar || ''));
function readAvatar() {
  const saved = partyStore.snapshot().profile.avatar || '';
  const mime = avatarMime[path.extname(saved).toLowerCase()];
  if (!saved || !mime) return null;
  try { return `data:${mime};base64,${fs.readFileSync(avatarPath()).toString('base64')}`; }
  catch { return null; }
}
ipcMain.handle('profile:photo', () => readAvatar());
ipcMain.handle('profile:photo:choose', async () => {
  const picked = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Imagens', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
  if (picked.canceled || !picked.filePaths[0]) return { canceled: true };
  const source = picked.filePaths[0], ext = path.extname(source).toLowerCase();
  const info = await fs.promises.stat(source);
  if (!avatarMime[ext] || info.size > 10 * 1024 * 1024) return { error: 'Escolha uma imagem PNG, JPG ou WebP de até 10 MB.' };
  const folder = app.getPath('userData');
  await fs.promises.mkdir(folder, { recursive: true });
  await Promise.all((await fs.promises.readdir(folder)).filter(name => name.startsWith('profile-avatar.'))
    .map(name => fs.promises.rm(path.join(folder, name), { force: true })));
  const name = `profile-avatar${ext}`;
  await fs.promises.copyFile(source, path.join(folder, name));
  partyStore.saveAvatar(name);
  return { url: readAvatar() };
});
ipcMain.handle('profile:photo:remove', async () => {
  const saved = partyStore.snapshot().profile.avatar;
  if (saved) await fs.promises.rm(avatarPath(), { force: true });
  partyStore.saveAvatar('');
  return { ok: true };
});
ipcMain.handle('update:check', async () => {
  try { return await checkForUpdate(); }
  catch (error) { return { status: 'error', message: error.message }; }
});
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('update:install', () => launchUpdateHelper());
ipcMain.handle('window:maximize-for-floating', event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { wasMaximized: false };
  const wasMaximized = win.isMaximized();
  if (!wasMaximized) win.maximize();
  return { wasMaximized };
});
ipcMain.handle('window:restore-after-floating', event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win?.isMaximized()) win.unmaximize();
});

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
  // Garante, silenciosamente, que o módulo acionável exista no AppData.
  ensureUpdaterModule().catch(() => {});
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
    backgroundColor: '#0b1424', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile('index.html');
});

app.on('window-all-closed', () => { stop(); app.quit(); });
