// ───────── Estado ─────────
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hue = s => [...String(s)].reduce((a, c) => a + c.charCodeAt(0) * 31, 7) % 360;
const RTC = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const deviceId = (() => {
  const saved = localStorage.getItem('party-p2p-device-id');
  if (saved) return saved;
  const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem('party-p2p-device-id', id);
  return id;
})();

const S = { id: '', nick: '', party: '', role: 'member', memberKey: '', invite: [], cur: null, voice: null, mic: null, share: null, shareAudio: null, q: null, muted: false, deaf: false };
const peers = new Map(), convs = new Map(), speaking = new Set(), watchers = new Map();
let ws, ac, mode = 'join', hosting = false, lastConnection = null, floatingPeer = null;
let floatingWindowMaximizedByUs = false;
let historyTimer = null;
const U = { state: 'idle', version: '', progress: null };
let partyMembers = null, partySubtab = 'users';

// Conversas: 'text' / 'voice' (canais da party), 'group' (grupo) e 'dm' (individual).
const nickOf = id => (id === S.id ? S.nick : peers.get(id)?.nick || '?');
const dmId = pid => 'd-' + [S.id, pid].sort().join('-');
const ensure = c => (convs.has(c.id) || convs.set(c.id, { msgs: [], unread: 0, ...c }), convs.get(c.id));
const avatarIcon = (nick, avatar) => `<i${avatar ? ' class="photo"' : ''} style="--h:${hue(nick)}${avatar ? `;background-image:url('${esc(avatar)}')` : ''}">${avatar ? '' : esc(nick[0] || '?')}</i>`;
const canAccess = c => !['text', 'voice'].includes(c?.type) || hosting || !c.restricted || (c.access || []).includes(S.memberKey);
function applyChannel(channel) {
  const current = convs.get(channel.id);
  if (current) Object.assign(current, { ...channel });
  else ensure({ ...channel, msgs: [], unread: 0 });
  if (S.cur === channel.id && !canAccess(channel)) S.cur = null;
  render();
}
function removeChannelLocal(id) {
  const channel = convs.get(id);
  if (S.voice === id) leaveVoice();
  convs.delete(id);
  if (S.cur === id) S.cur = convs.keys().next().value || null;
  if (channel) persistHistory();
  render();
}
const dmConv = pid => ensure({ id: dmId(pid), type: 'dm', peer: pid });
const others = c => (c.type === 'dm' ? [c.peer] : c.type === 'group' ? c.members.filter(i => i !== S.id) : [...peers.keys()]);
const title = c => (c.type === 'dm' ? nickOf(c.peer) : c.name);
const tell = (ids, m) => ids.forEach(i => { const d = peers.get(i)?.dc; if (d?.readyState === 'open') d.send(JSON.stringify(m)); });
const sig = (to, data) => ws.send(JSON.stringify({ t: 'signal', to, data }));
const vstate = () => ({ t: 'voice', c: S.voice, m: S.muted || S.deaf, s: !!S.share });
const announce = () => tell([...peers.keys()], vstate());

function historySnapshot() {
  return [...convs.values()].map(c => ({
    id: c.id, type: c.type, name: c.name, peer: c.peer, members: c.members,
    msgs: c.msgs.map(m => ({ n: m.n, text: m.text, ts: m.ts })),
  }));
}
function persistHistory() {
  if (!hosting) return;
  const snapshot = historySnapshot();
  bridge.persistence.syncHistory(snapshot).catch(() => {});
  clearTimeout(historyTimer);
  historyTimer = setTimeout(() => bridge.persistence.saveHistory(snapshot).catch(() => {}), 500);
}
function restoreHistory(history) {
  (history || []).forEach(c => ensure({ ...c, msgs: Array.isArray(c.msgs) ? c.msgs : [], unread: 0 }));
}
function applyGroup(group) {
  const current = convs.get(group.id);
  if (current && current.owner && current.owner !== group.owner) return;
  const next = {
    id: String(group.id), type: 'group', name: String(group.name).slice(0, 30),
    owner: String(group.owner || ''), members: group.members.map(String),
  };
  if (current) Object.assign(current, next);
  else ensure(next);
}
function removeGroup(id) {
  convs.delete(id);
  if (S.cur === id) S.cur = convs.keys().next().value || null;
  persistHistory(); render();
}
let recentParties = [];
function renderRecentParties(parties) {
  recentParties = parties || [];
  const section = $('#recent-parties'), list = $('#recent-list');
  section.hidden = !recentParties.length;
  list.innerHTML = recentParties.map((party, index) => `<button type="button" class="recent-party" data-recent="${index}">
    <b>${esc(party.name)}</b><small>${esc(party.nick)} · ${esc(party.address)}</small><span>Entrar</span>
  </button>`).join('');
}
function joinRecent(index) {
  const party = recentParties[index]; if (!party) return;
  $('#nick').value = party.nick || $('#nick').value;
  $('#addr').value = party.address;
  $('#pass').value = party.password || '';
  selectMode('join');
  $('#lf').requestSubmit();
}
const QUAL = [
  { label: '720p, 30 fps', w: 1280, h: 720, fps: 30, bps: 2.5e6 },
  { label: '1080p, 30 fps', w: 1920, h: 1080, fps: 30, bps: 5e6 },
  { label: '1080p, 60 fps', w: 1920, h: 1080, fps: 60, bps: 8e6 },
];

// ───────── Conexão com o host (só sinalização) ─────────
function connect(addr, nick, password) {
  lastConnection = { address: addr, nick, password };
  ws = new WebSocket('ws://' + (addr.includes(':') ? addr : addr + ':7777'));
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', nick, password, device: deviceId, avatar: S.avatar || null }));
  ws.onerror = () => fail('Não foi possível conectar ao host. Confira o endereço, a porta e o firewall.');
  ws.onclose = () => S.id && toast('O host da party saiu. Quem já está conectado continua, mas ninguém novo consegue entrar.');
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.t === 'error') {
      if (S.id) {
        toast(m.msg);
        ws.onclose = null;
        setTimeout(() => location.reload(), 900);
      } else fail(m.msg);
    }
    else if (m.t === 'welcome') {
      S.id = m.id; S.party = m.party; S.role = m.role || 'member'; S.memberKey = m.memberKey || '';
      if (!hosting && lastConnection) bridge.persistence.saveRecent({ name: S.party, ...lastConnection }).catch(() => {});
      restoreHistory(m.history);
      m.channels.forEach(channel => Object.assign(ensure(channel), channel));
      m.members.forEach(x => addPeer(x.id, x.nick, true, x.avatar)); // quem chega liga para quem já está
      enter(); open(m.channels[0].id);
    }
    else if (m.t === 'peer-join') addPeer(m.id, m.nick, false, m.avatar);
    else if (m.t === 'peer-leave') removePeer(m.id);
    else if (m.t === 'peer-avatar') {
      const peer = peers.get(m.id);
      if (peer) { peer.avatar = m.avatar || null; render(); }
    }
    else if (m.t === 'signal') onSig(m.from, m.data);
    else if (m.t === 'channel-add' || m.t === 'channel-update') applyChannel(m.ch);
    else if (m.t === 'channel-remove') removeChannelLocal(m.id);
    else if (m.t === 'admin-members') {
      partyMembers = Array.isArray(m.members) ? m.members : [];
      if (settingsTab === 'party') renderPartySettings();
    }
    else if (m.t === 'permission') {
      S.role = m.role || 'member';
      if (settingsTab === 'party' && !hosting && S.role !== 'admin') {
        settingsTab = 'profile'; renderSettingsTab();
      } else if (settingsTab === 'party') renderPartySettings();
    }
  };
}
function fail(msg) {
  if (S.id) return;
  $('#err').textContent = msg; $('#go').disabled = false;
  if (hosting) { bridge.stop(); hosting = false; }
}

// ───────── Malha P2P (WebRTC): 1 conexão por par com canal de dados + áudio ─────────
function addPeer(id, nick, init, avatar = null) {
  const p = { id, nick, avatar: avatar || null, voice: null, m: false, pend: [], state: 'new', sharing: false, watch: false, watching: false, vtrack: null };
  const pc = (p.pc = new RTCPeerConnection(RTC));
  peers.set(id, p);
  pc.onicecandidate = e => e.candidate && sig(id, { ice: e.candidate });
  pc.ondatachannel = e => bind(p, e.channel);
  pc.onconnectionstatechange = () => { p.state = pc.connectionState; render(); };
  pc.ontrack = e => {
    if (e.track.kind === 'video') { p.vstream = new MediaStream([e.track]); render(); return; }
    p.astream ||= new MediaStream(); p.astream.addTrack(e.track);
    p.el ||= new Audio(); p.el.srcObject = p.astream;
    p.el.play().catch(() => {}); watch(id, p.astream); apply();
  };
  if (init) {
    bind(p, pc.createDataChannel('d'));
    p.tx = pc.addTransceiver('audio', { direction: 'sendrecv' }); // o microfone entra depois, via replaceTrack
    p.stx = pc.addTransceiver('audio', { direction: 'sendrecv' }); // áudio da transmissão de tela
    p.vx = pc.addTransceiver('video', { direction: 'sendrecv' }); // a tela entra depois, via replaceTrack
    pc.setLocalDescription().then(() => sig(id, { sdp: pc.localDescription }));
  }
  render();
}

async function onSig(from, d) {
  const p = peers.get(from); if (!p) return;
  const pc = p.pc;
  if (d.sdp) {
    await pc.setRemoteDescription(d.sdp);
    for (const c of p.pend.splice(0)) pc.addIceCandidate(c).catch(() => {});
    if (d.sdp.type === 'offer') {
      const audio = pc.getTransceivers().filter(t => t.receiver.track.kind === 'audio');
      [p.tx, p.stx] = audio;
      p.tx.direction = 'sendrecv';
      p.stx.direction = 'sendrecv';
      p.vx = pc.getTransceivers().find(t => t.receiver.track.kind === 'video');
      p.vx.direction = 'sendrecv';
      await pc.setLocalDescription();
      sig(from, { sdp: pc.localDescription });
    }
    apply();
  } else if (d.ice) {
    pc.remoteDescription ? pc.addIceCandidate(d.ice).catch(() => {}) : p.pend.push(d.ice);
  }
}

function removePeer(id) {
  const p = peers.get(id); if (!p) return;
  peers.delete(id); p.pc.close(); if (p.el) p.el.srcObject = null; p.vel?.remove();
  unwatch(id); render();
}

function bind(p, dc) {
  p.dc = dc;
  dc.onopen = () => tell([p.id], vstate());
  dc.onclose = () => removePeer(p.id);
  dc.onmessage = e => { try { handle(p, JSON.parse(e.data)); } catch {} };
}

function handle(p, m) {
  if (m.t === 'msg') {
    const c = m.c === 'dm' ? dmConv(p.id) : convs.get(m.c);
    if (!c || !canAccess(c) || c.type === 'dm' && m.c !== 'dm' || c.type === 'group' && !c.members.includes(p.id)) return;
    c.msgs.push({ n: p.nick, text: String(m.text).slice(0, 2000), ts: Date.now() });
    persistHistory();
    if (S.cur !== c.id) c.unread++;
    render();
  } else if (m.t === 'group') {
    if (String(m.id).startsWith('g-') && m.members?.includes(S.id) && (p.nick === m.owner || p.nick === m.manager))
      { applyGroup(m); persistHistory(); render(); }
  } else if (m.t === 'group-remove' || m.t === 'group-delete') {
    const c = convs.get(m.id);
    if (c?.owner === m.owner && (p.nick === m.owner || p.nick === m.manager)) removeGroup(m.id);
  } else if (m.t === 'watch') {
    p.watching = !!m.on; apply();
  } else if (m.t === 'voice') {
    if (p.voice !== m.c) p.watching = false;
    p.voice = m.c; p.m = !!m.m; p.sharing = !!m.s; apply(); render();
  } else if (m.t === 'ring') {
    const c = m.c === 'dm' ? dmConv(p.id) : convs.get(m.c);
    if (c && c.type !== 'text' && S.voice !== c.id)
      toast(`📞 ${p.nick} está te chamando`, () => { open(c.id); joinVoice(c.id); });
  }
}

// ───────── Voz ─────────
// Só mando o microfone para quem está na MESMA sala de voz que eu; o resto recebe silêncio.
function apply() {
  if (S.mic) S.mic.enabled = !S.muted && !S.deaf;
  peers.forEach(p => {
    const together = !!S.voice && p.voice === S.voice;
    p.tx?.sender.replaceTrack(together ? S.mic : null).catch(() => {});
    p.stx?.sender.replaceTrack(together && p.watching ? S.shareAudio : null).catch(() => {});
    if (p.el) p.el.muted = !together || S.deaf;
    if (p.watch && !(together && p.sharing)) p.watch = false;
    setVideo(p, S.share && together && p.watching ? S.share : null); // a tela só vai para quem clicou em Assistir
  });
}

function setVideo(p, track) {
  if (!p.vx || p.vtrack === track) return;
  p.vtrack = track;
  p.vx.sender.replaceTrack(track).then(() => {
    if (!track) return;
    const s = p.vx.sender, pr = s.getParameters();
    if (!pr.encodings?.length) pr.encodings = [{}];
    pr.encodings[0].maxBitrate = S.q.bps;
    pr.degradationPreference = S.q.fps > 30 ? 'maintain-framerate' : 'maintain-resolution';
    return s.setParameters(pr);
  }).catch(() => {});
}

async function joinVoice(id) {
  if (!canAccess(convs.get(id))) return toast('Você não tem acesso a este canal.');
  try {
    if (!S.mic) {
      const st = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      S.mic = st.getAudioTracks()[0]; watch(S.id, st);
    }
  } catch { return toast('Sem acesso ao microfone. Verifique as permissões do Windows.'); }
  if (S.voice && S.voice !== id) { stopShare(); resetWatch(); }
  S.voice = id; announce(); apply(); render();
  const c = convs.get(id);
  if (c.type === 'dm' || c.type === 'group') tell(others(c), { t: 'ring', c: c.type === 'dm' ? 'dm' : c.id });
}

function leaveVoice() {
  stopShare(); resetWatch();
  S.voice = null; S.mic?.stop(); S.mic = null; unwatch(S.id);
  announce(); apply(); render();
}

// ───────── Compartilhamento de tela ─────────
// Cada par já tem uma faixa de vídeo e outra de áudio da transmissão negociadas. Elas só são
// enviadas a quem pediu para assistir, porque cada espectador custa uma cópia no upload.
async function pickScreen() {
  let list;
  try { list = await bridge.sources(); } catch { return toast('Não foi possível listar as telas.'); }
  const d = $('#dlg');
  d.className = 'wide';
  d.innerHTML = `<form method="dialog"><h3>Compartilhar tela</h3>
    <div class="srcs">${list.map((s, i) => `<label class="src"><input type="radio" name="s" value="${esc(s.id)}"${i ? '' : ' checked'}><img src="${s.thumb}" alt=""><span>${esc(s.name)}</span></label>`).join('')}</div>
    <label>Qualidade <select name="q">${QUAL.map((q, i) => `<option value="${i}">${q.label}</option>`).join('')}</select></label>
    <label class="ck"><input type="checkbox" name="audio" checked> Compartilhar áudio do sistema</label>
    <p class="dim">Cada pessoa que assistir usa essa banda do seu upload.</p>
    <menu><button value="ok" class="go">Transmitir</button><button value="x" formnovalidate>Cancelar</button></menu></form>`;
  d.returnValue = '';
  d.onclose = () => {
    const r = d.querySelector('[name=s]:checked');
    if (d.returnValue === 'ok' && r) startShare(r.value, QUAL[d.querySelector('[name=q]').value], d.querySelector('[name=audio]').checked);
  };
  d.showModal();
}

async function startShare(id, q, withAudio) {
  try {
    await bridge.pick({ id, audio: withAudio });
    const st = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: q.w, max: q.w }, height: { ideal: q.h, max: q.h }, frameRate: { ideal: q.fps, max: q.fps } },
      audio: withAudio,
    });
    S.share = st.getVideoTracks()[0]; S.shareAudio = st.getAudioTracks()[0] || null; S.q = q;
    S.share.contentHint = q.fps > 30 ? 'motion' : 'detail';
    S.share.onended = stopShare; // quando a janela some ou o Windows interrompe a captura
  } catch { return toast('Não foi possível iniciar a transmissão.'); }
  announce(); apply(); render();
}

function stopShare() {
  if (!S.share) return;
  S.share.onended = null; S.share.stop(); S.share = null;
  S.shareAudio?.stop(); S.shareAudio = null;
  peers.forEach(p => (p.watching = false));
  announce(); apply(); render();
}

function watchOn(id, on) {
  const p = peers.get(id); if (!p) return;
  p.watch = on; tell([id], { t: 'watch', on }); render();
}

function resetWatch() {
  peers.forEach(p => { if (p.watch) tell([p.id], { t: 'watch', on: false }); p.watch = false; p.watching = false; });
}

// Área de transmissões acima do chat. Só é reconstruída quando algo muda, para o vídeo não piscar.
function renderStage() {
  const st = $('#stage'), live = !!S.voice && S.cur === S.voice;
  const sh = live ? [...peers.values()].filter(p => p.sharing && p.voice === S.voice) : [];
  const key = [live && S.share ? 'eu' : '', floatingPeer || '', ...sh.map(p => p.id + (p.watch ? 'w' : '') + (p.vstream ? 'v' : ''))].join(',');
  if (st.dataset.k === key) { renderFloating(sh); return; }
  st.dataset.k = key;
  const tiles = [];
  const tile = html => Object.assign(document.createElement('div'), { className: 'tile', innerHTML: html });
  if (live && S.share) tiles.push(tile('<div class="ph">Você está transmitindo sua tela<button class="bad" data-unshare>Parar</button></div>'));
  sh.forEach(p => {
    if (p.id === floatingPeer) return;
    if (!p.watch || !p.vstream) return tiles.push(tile(`<div class="ph"><b>${esc(p.nick)}</b> está transmitindo<button class="go" data-watch="${p.id}">Assistir</button></div>`));
    if (!p.vel) {
      p.vel = Object.assign(document.createElement('video'), { autoplay: true, muted: true });
      p.vel.ondblclick = () => floatScreen(p.id);
    }
    p.vel.srcObject = p.vstream;
    const t = tile(`<span class="tl">${esc(p.nick)}</span><div class="tb"><button data-float="${p.id}" title="Abrir tela flutuante">⧉</button><button data-unwatch="${p.id}">Parar de assistir</button></div>`);
    p.tile = t; t.prepend(p.vel); tiles.push(t); p.vel.play().catch(() => {});
  });
  st.replaceChildren(...tiles); st.hidden = !tiles.length;
  renderFloating(sh);
}

function renderFloating(shared) {
  const panel = $('#floating-screen'), host = $('#floating-screen-video');
  const peer = shared.find(p => p.id === floatingPeer);
  if (!peer || !peer.watch || !peer.vstream) { panel.hidden = true; return; }
  if (!peer.vel) {
    peer.vel = Object.assign(document.createElement('video'), { autoplay: true, muted: true });
    peer.vel.ondblclick = () => fullScreen(peer);
  }
  peer.vel.srcObject = peer.vstream;
  $('#floating-screen-title').textContent = `Transmissão de ${peer.nick}`;
  host.replaceChildren(peer.vel); panel.hidden = false; peer.vel.play().catch(() => {});
}

function floatScreen(id) {
  floatingPeer = id; renderStage();
}
function closeFloating() {
  floatingPeer = null;
  exitFloatingMaximized();
  renderStage();
}

async function exitFloatingMaximized() {
  const panel = $('#floating-screen');
  if (!panel.classList.contains('floating-maximized')) return;
  panel.classList.remove('floating-maximized');
  $('#floating-full').textContent = '⛶';
  $('#floating-full').title = 'Tela cheia';
  if (floatingWindowMaximizedByUs) await bridge.window.restoreAfterFloating();
  floatingWindowMaximizedByUs = false;
}

// Indicador de quem está falando (analisador de volume em cada fluxo de áudio)
function watch(id, stream) {
  unwatch(id);
  const an = ac.createAnalyser(); an.fftSize = 512;
  ac.createMediaStreamSource(stream).connect(an);
  const buf = new Uint8Array(an.fftSize);
  watchers.set(id, setInterval(() => {
    an.getByteTimeDomainData(buf);
    const on = buf.some(v => Math.abs(v - 128) > 10);
    if (on !== speaking.has(id)) { on ? speaking.add(id) : speaking.delete(id); paint(); }
  }, 100));
}
function unwatch(id) { clearInterval(watchers.get(id)); watchers.delete(id); speaking.delete(id); paint(); }
const paint = () => document.querySelectorAll('[data-u]').forEach(e => e.classList.toggle('speak', speaking.has(e.dataset.u)));

// ───────── Ações ─────────
function open(id) {
  const channel = convs.get(id);
  if (!channel || !canAccess(channel)) return toast('Você não tem acesso a este canal.');
  S.cur = id; channel.unread = 0; render(); $('#txt').focus();
}

function say(text) {
  const c = convs.get(S.cur); text = text.trim();
  if (!c || !text || !canAccess(c)) return;
  const ts = Date.now();
  c.msgs.push({ n: S.nick, text, ts });
  persistHistory();
  tell(others(c), { t: 'msg', c: c.type === 'dm' ? 'dm' : c.id, text });
  render();
}

function ask(kind) {
  const d = $('#dlg'), ps = [...peers.values()];
  d.innerHTML = `<form method="dialog"><h3>${{ text: 'Novo canal de texto', voice: 'Novo canal de voz', group: 'Novo grupo' }[kind]}</h3>
    <input name="n" placeholder="Nome" maxlength="30" required autofocus>` +
    (kind === 'group' ? ps.map(p => `<label class="ck"><input type="checkbox" value="${p.id}"> ${esc(p.nick)}</label>`).join('') || '<p class="dim">Ninguém online para adicionar ainda.</p>' : '') +
    '<menu><button value="ok" class="go">Criar</button><button value="x" formnovalidate>Cancelar</button></menu></form>';
  d.className = ''; d.returnValue = '';
  d.onclose = () => {
    if (d.returnValue !== 'ok') return;
    const n = d.querySelector('[name=n]').value.trim(); if (!n) return;
    if (kind !== 'group') return ws.send(JSON.stringify({ t: 'channel-add', type: kind, name: n }));
    const members = [S.id, ...[...d.querySelectorAll('[type=checkbox]:checked')].map(x => x.value)];
    const id = 'g-' + Math.random().toString(36).slice(2, 8);
    ensure({ id, type: 'group', name: n, owner: S.nick, members });
    persistHistory();
    tell(members.filter(i => i !== S.id), { t: 'group', id, name: n, owner: S.nick, members });
    open(id);
  };
  d.showModal();
}

function manageGroup(id = S.cur) {
  const c = convs.get(id);
  if (!c || c.type !== 'group' || (!hosting && c.owner !== S.nick)) return;
  const d = $('#manage-dlg'), ps = [...peers.values()];
  d.className = '';
  d.innerHTML = `<form method="dialog"><h3>Gerenciar ${esc(c.name)}</h3>
    <input name="n" value="${esc(c.name)}" maxlength="30" required>
    <p class="dim">Escolha quem pode acessar este grupo.</p>
    <label class="ck"><input type="checkbox" checked disabled> ${esc(S.nick)} (criador)</label>` +
    ps.map(p => `<label class="ck"><input type="checkbox" value="${p.id}"${c.members.includes(p.id) ? ' checked' : ''}> ${esc(p.nick)}</label>`).join('') +
    `<menu><button value="delete" class="bad">Excluir grupo</button><button value="ok" class="go">Salvar acesso</button><button value="x" formnovalidate>Cancelar</button></menu></form>`;
  d.returnValue = '';
  d.onclose = () => {
    if (d.returnValue === 'delete') {
      tell(c.members.filter(id => id !== S.id), { t: 'group-delete', id: c.id, owner: c.owner, manager: S.nick });
      return removeGroup(c.id);
    }
    if (d.returnValue !== 'ok') return;
    const name = d.querySelector('[name=n]').value.trim(); if (!name) return;
    const members = [S.id, ...[...d.querySelectorAll('[type=checkbox]:checked')].map(input => input.value).filter(Boolean)];
    const removed = c.members.filter(id => !members.includes(id) && id !== S.id);
    c.members = members; c.name = name;
    tell(removed, { t: 'group-remove', id: c.id, owner: c.owner, manager: S.nick });
    tell(members.filter(id => id !== S.id), { t: 'group', id: c.id, name: c.name, owner: c.owner, manager: S.nick, members });
    persistHistory(); render();
  };
  d.showModal();
}

function toast(text, yes, yesLabel = 'Atender') {
  const d = document.createElement('div'); d.className = 'toast';
  d.innerHTML = `<span>${esc(text)}</span>${yes ? `<button class="go">${esc(yesLabel)}</button>` : ''}<button>✕</button>`;
  d.querySelector('.go')?.addEventListener('click', () => { yes(); d.remove(); });
  d.querySelector('button:last-child').onclick = () => d.remove();
  setTimeout(() => d.remove(), yes ? 25000 : 8000);
  $('#toasts').append(d);
}

// ───────── Interface ─────────
function enter() {
  $('#login').hidden = true; $('#app').hidden = false;
  $('#me').dataset.u = S.id;
  $('#ph').innerHTML = `<b>${esc(S.party)}</b><button id="settings" title="Configurações">⚙</button><button id="leave" title="Sair da party">Sair</button>` +
    (hosting ? `<small id="inv" title="${esc(S.invite.join('  ·  '))}">Endereço p/ convidar: ${esc(S.invite[0] || 'sem rede')} (clique para copiar)</small>` : '');
  $('#leave').onclick = () => bridge.stop().finally(() => location.reload());
  if (hosting) $('#inv').onclick = () => { navigator.clipboard.writeText(S.invite[0] || ''); toast('Endereço copiado.'); };
  $('#settings').onclick = openSettings;
}

function renderUpdateSettings() {
  const button = $('#settings-update'), detail = $('#settings-update-detail');
  const progress = $('#settings-update-progress'), meter = $('#settings-update-meter'), label = $('#settings-update-percent');
  if (!button || !detail) return;
  const labels = {
    idle: 'Verificar atualizações', checking: 'Verificando…', available: `Baixar v${U.version}`,
    downloading: 'Baixando…', downloaded: `Instalar v${U.version}`, installing: 'Reiniciando…',
  };
  const details = {
    idle: U.message || 'Consulte a versão mais recente publicada no GitHub.',
    checking: 'Consultando a release mais recente…',
    available: `A versão ${U.version} está disponível para download.`,
    downloading: U.progress?.total ? `Baixando a atualização: ${U.progress.percent}% concluído.` : 'Baixando a atualização…',
    downloaded: `A versão ${U.version} foi baixada e está pronta para instalar.`,
    installing: 'Encerrando a versão atual, substituindo o executável e abrindo a nova versão…',
  };
  button.textContent = labels[U.state] || 'Verificar atualizações';
  button.disabled = U.state === 'checking' || U.state === 'downloading' || U.state === 'installing';
  detail.textContent = details[U.state] || U.message || 'Não foi possível verificar atualizações.';
  if (progress && meter && label) {
    progress.hidden = U.state !== 'downloading';
    meter.value = U.progress?.percent || 0;
    label.textContent = U.progress?.total ? `${U.progress.percent}%` : 'Preparando download…';
  }
}

let settingsTab = 'profile';
function renderSettingsTab() {
  const content = $('#settings-content'); if (!content) return;
  if (settingsTab === 'updates') {
    content.innerHTML = `<section class="setting"><b>Atualizações</b><p id="settings-update-detail" class="dim"></p><div id="settings-update-progress" class="update-progress" hidden><progress id="settings-update-meter" max="100" value="0"></progress><span id="settings-update-percent"></span></div><button type="button" id="settings-update"></button></section>`;
    content.querySelector('#settings-update').onclick = updateApp;
    renderUpdateSettings();
    if (U.state === 'idle') checkForUpdate();
    return;
  }
  if (settingsTab === 'party') {
    renderPartySettings();
    return;
  }
  content.innerHTML = `<section class="setting profile-setting"><b>Perfil</b><div class="profile-photo">${S.avatar ? `<img src="${esc(S.avatar)}" alt="Foto de perfil">` : `<i>${esc((S.nick || $('#nick').value || '?')[0])}</i>`}</div><p class="dim">A foto é salva neste computador e compartilhada com a party.</p><div class="acts"><button type="button" id="profile-photo-choose" class="go">Escolher foto</button>${S.avatar ? '<button type="button" id="profile-photo-remove">Remover</button>' : ''}</div></section>`;
  content.querySelector('#profile-photo-choose').onclick = chooseProfilePhoto;
  content.querySelector('#profile-photo-remove')?.addEventListener('click', removeProfilePhoto);
}

async function chooseProfilePhoto() {
  const result = await bridge.profile.choosePhoto();
  if (result.error) return toast(result.error);
  if (result.url) { S.avatar = result.url; syncProfileAvatar(); renderSettingsTab(); render(); }
}
async function removeProfilePhoto() {
  await bridge.profile.removePhoto(); S.avatar = null; syncProfileAvatar(); renderSettingsTab(); render();
}
function syncProfileAvatar() {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'profile-avatar', avatar: S.avatar || null }));
}

async function renderPartySettings() {
  const content = $('#settings-content'); if (!content || (!hosting && S.role !== 'admin')) return;
  content.innerHTML = '<section class="setting"><b>Controle de usuários</b><p class="dim">Carregando membros…</p></section>';
  if (!hosting && partyMembers === null) {
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: 'admin-members' }));
    return;
  }
  const members = hosting ? await bridge.party.members() : partyMembers;
  if (settingsTab !== 'party' || !$('#settings-content')) return;
  const managedChannels = hosting && partySubtab === 'content' ? await bridge.party.channels() : [];
  if (settingsTab !== 'party' || !$('#settings-content')) return;
  const timestamp = value => value ? new Date(value).toLocaleString('pt-BR') : 'Sem registro';
  const tabs = `<div class="party-tabs"><button type="button" data-party-tab="users" class="${partySubtab === 'users' ? 'selected' : ''}">Usuários</button>${hosting ? `<button type="button" data-party-tab="permissions" class="${partySubtab === 'permissions' ? 'selected' : ''}">Permissões</button><button type="button" data-party-tab="content" class="${partySubtab === 'content' ? 'selected' : ''}">Canais e grupos</button>` : ''}</div>`;
  const rows = members.map(member => {
    const protectedAdmin = member.owner || (!hosting && member.role === 'admin');
    const actions = protectedAdmin ? '' : member.banned
      ? `<button type="button" data-member-action="unban" data-member="${esc(member.key)}">Remover banimento</button><button type="button" data-member-action="remove" data-member="${esc(member.key)}">Excluir registro</button>`
      : `<button type="button" data-member-action="remove" data-member="${esc(member.key)}">${member.online ? 'Remover' : 'Remover registro'}</button><button type="button" class="bad" data-member-action="ban" data-member="${esc(member.key)}">Banir</button>`;
    return `<article class="member-control"><div><b>${esc(member.nick)}</b><small>${member.owner ? 'Anfitrião · ' : ''}${member.role === 'admin' ? 'Administrador · ' : ''}${member.banned ? 'Banido' : member.online ? 'Online' : 'Offline'} · Último acesso: ${esc(timestamp(member.lastSeen))}</small></div><div class="member-actions">${actions}</div></article>`;
  }).join('') || '<p class="dim">Ainda não houve acessos nesta party.</p>';
  const permissions = members.map(member => `<article class="member-control"><div><b>${esc(member.nick)}</b><small>${member.owner ? 'Anfitrião e administrador da party' : member.role === 'admin' ? 'Administrador da party' : 'Usuário padrão'}</small></div><div class="member-actions">${member.owner ? '' : `<button type="button" data-member-role="${member.role === 'admin' ? 'member' : 'admin'}" data-member="${esc(member.key)}">${member.role === 'admin' ? 'Remover admin' : 'Tornar admin'}</button>`}</div></article>`).join('') || '<p class="dim">Ainda não houve acessos nesta party.</p>';
  const groups = [...convs.values()].filter(conversation => conversation.type === 'group');
  const contentManagement = `<div class="setting-heading"><div><b>Canais</b><p class="dim">Defina nome e quem pode acessar cada canal.</p></div></div><div class="member-controls">${managedChannels.map(channel => `<article class="member-control"><div><b>${channel.type === 'voice' ? '🔊' : '#'} ${esc(channel.name)}</b><small>${channel.restricted ? `${channel.access.length} usuário(s) com acesso` : 'Acesso para todos'}</small></div><div class="member-actions"><button type="button" data-channel-edit="${esc(channel.id)}">Editar</button><button type="button" class="bad" data-channel-remove="${esc(channel.id)}">Excluir</button></div></article>`).join('') || '<p class="dim">Nenhum canal.</p>'}</div><div class="setting-heading"><div><b>Grupos</b><p class="dim">Edite nome e participantes dos grupos registrados na party.</p></div></div><div class="member-controls">${groups.map(group => `<article class="member-control"><div><b>👥 ${esc(group.name)}</b><small>${Math.max(0, (group.members || []).length - 1)} participante(s) · Criado por ${esc(group.owner)}</small></div><div class="member-actions"><button type="button" data-group-settings="${esc(group.id)}">Editar</button></div></article>`).join('') || '<p class="dim">Nenhum grupo registrado.</p>'}</div>`;
  const body = partySubtab === 'permissions'
    ? `<p class="dim">Administradores podem gerenciar usuários, remover registros e aplicar banimentos.</p><div class="member-controls">${permissions}</div>`
    : partySubtab === 'content' ? contentManagement
    : `<div class="setting-heading"><div><b>Controle de usuários</b><p class="dim">Registro de todos os apelidos que já acessaram esta party.</p></div><button type="button" id="members-refresh">Atualizar</button></div><div class="member-controls">${rows}</div>`;
  content.innerHTML = `<section class="setting">${tabs}${body}</section>`;
  content.querySelectorAll('[data-party-tab]').forEach(button => button.onclick = () => { partySubtab = button.dataset.partyTab; renderPartySettings(); });
  $('#members-refresh')?.addEventListener('click', () => {
    if (!hosting) { partyMembers = null; ws?.send(JSON.stringify({ t: 'admin-members' })); }
    renderPartySettings();
  });
  content.querySelectorAll('[data-member-action]').forEach(button => button.onclick = async () => {
    const result = hosting
      ? await bridge.party.memberAction(button.dataset.memberAction, button.dataset.member)
      : (ws.send(JSON.stringify({ t: 'admin-action', action: button.dataset.memberAction, key: button.dataset.member })), null);
    if (result?.error) toast(result.error);
    if (hosting) renderPartySettings();
  });
  content.querySelectorAll('[data-member-role]').forEach(button => button.onclick = async () => {
    const result = await bridge.party.memberPermission(button.dataset.member, button.dataset.memberRole);
    if (result?.error) toast(result.error);
    renderPartySettings();
  });
  content.querySelectorAll('[data-channel-edit]').forEach(button => button.onclick = () => editChannel(button.dataset.channelEdit, members));
  content.querySelectorAll('[data-channel-remove]').forEach(button => button.onclick = async () => {
    const result = await bridge.party.removeChannel(button.dataset.channelRemove);
    if (result.error) toast(result.error); else removeChannelLocal(button.dataset.channelRemove);
    renderPartySettings();
  });
  content.querySelectorAll('[data-group-settings]').forEach(button => button.onclick = () => manageGroup(button.dataset.groupSettings));
}

async function editChannel(id, members) {
  const channels = await bridge.party.channels();
  const channel = channels.find(item => item.id === id); if (!channel) return toast('Canal não encontrado.');
  const d = $('#manage-dlg');
  const access = new Set(channel.access || []);
  d.className = '';
  d.innerHTML = `<form method="dialog"><h3>Editar canal</h3><input name="n" value="${esc(channel.name)}" maxlength="30" required><label class="ck"><input name="restricted" type="checkbox"${channel.restricted ? ' checked' : ''}> Restringir acesso</label><div id="channel-access">${members.map(member => `<label class="ck"><input type="checkbox" name="access" value="${esc(member.key)}"${access.has(member.key) ? ' checked' : ''}> ${esc(member.nick)}${member.owner ? ' (anfitrião)' : ''}</label>`).join('') || '<p class="dim">Nenhum usuário registrado.</p>'}</div><menu><button value="ok" class="go">Salvar</button><button value="x" formnovalidate>Cancelar</button></menu></form>`;
  const restricted = d.querySelector('[name=restricted]'), accessList = d.querySelector('#channel-access');
  const updateAccessState = () => { accessList.hidden = !restricted.checked; };
  restricted.onchange = updateAccessState; updateAccessState();
  d.returnValue = '';
  d.onclose = async () => {
    if (d.returnValue !== 'ok') return;
    const name = d.querySelector('[name=n]').value.trim(); if (!name) return;
    const result = await bridge.party.updateChannel(channel.id, {
      name, restricted: restricted.checked,
      access: [...d.querySelectorAll('[name=access]:checked')].map(input => input.value),
    });
    if (result.error) return toast(result.error);
    applyChannel(result.channel); renderPartySettings();
  };
  d.showModal();
}

function openSettings(tab = 'profile') {
  settingsTab = tab;
  const d = $('#dlg');
  d.className = hosting ? 'wide' : '';
  d.innerHTML = `<form method="dialog"><h3>Configurações</h3>
    <div class="settings-tabs"><button type="button" data-settings-tab="profile">Perfil</button>${hosting || S.role === 'admin' ? '<button type="button" data-settings-tab="party">Party</button>' : ''}<button type="button" data-settings-tab="updates">Atualizações</button></div><div id="settings-content"></div>
    <menu><button value="ok" class="go">Fechar</button></menu></form>`;
  d.querySelectorAll('[data-settings-tab]').forEach(button => button.onclick = () => { settingsTab = button.dataset.settingsTab; renderSettingsTab(); });
  d.showModal();
  renderSettingsTab();
}

async function checkForUpdate() {
  U.state = 'checking'; U.message = ''; renderUpdateSettings();
  const result = await bridge.update.check();
  if (result.status === 'available') {
    U.state = 'available'; U.version = result.version;
  } else {
    U.state = 'idle'; U.message = result.status === 'current'
      ? 'Você já está na versão mais recente.'
      : result.message || 'Não foi possível verificar atualizações.';
  }
  renderUpdateSettings();
}

async function updateApp() {
  if (U.state === 'idle') return checkForUpdate();
  if (U.state === 'available') {
    U.state = 'downloading'; U.progress = { percent: 0, total: 0 }; renderUpdateSettings();
    const result = await bridge.update.download();
    if (result.status === 'downloaded') {
      U.state = 'downloaded'; U.version = result.version; U.progress = null;
    } else { U.state = 'available'; U.progress = null; U.message = result.message || 'Não foi possível baixar a atualização.'; }
    renderUpdateSettings();
  } else if (U.state === 'downloaded') {
    U.state = 'installing'; renderUpdateSettings();
    const result = await bridge.update.install();
    if (result.status !== 'installing') { U.state = 'downloaded'; U.message = result.message || 'Não foi possível instalar a atualização.'; renderUpdateSettings(); }
  }
}

async function fullScreen(peer) {
  if (peer && floatingPeer !== peer.id) floatScreen(peer.id);
  const panel = $('#floating-screen');
  if (panel.classList.contains('floating-maximized')) return exitFloatingMaximized();
  const result = await bridge.window.maximizeForFloating();
  floatingWindowMaximizedByUs = !result.wasMaximized;
  panel.classList.add('floating-maximized');
  $('#floating-full').textContent = '⤢';
  $('#floating-full').title = 'Restaurar tamanho flutuante';
}

function render() {
  const cs = [...convs.values()], ps = [...peers.values()];
  const by = ty => cs.filter(c => c.type === ty && canAccess(c));
  const inCall = c => [...(S.voice === c.id ? [S.id] : []), ...ps.filter(p => p.voice === c.id).map(p => p.id)];
  const row = (c, ic) => `<div class="it${S.cur === c.id ? ' on' : ''}" data-c="${c.id}"><u>${ic}</u><span>${esc(title(c))}</span>${c.unread ? `<b>${c.unread}</b>` : ''}</div>`;
  const users = c => inCall(c).map(i => `<div class="vu" data-u="${i}">${avatarIcon(nickOf(i), i === S.id ? S.avatar : peers.get(i)?.avatar)}${esc(nickOf(i))}${(i === S.id ? S.share : peers.get(i).sharing) ? '<span class="live">Ao vivo</span>' : ''}${(i === S.id ? S.muted || S.deaf : peers.get(i).m) ? ' <s>🔇</s>' : ''}</div>`).join('');
  const sec = (t, k, list) => `<h4>${t}${k ? `<button data-new="${k}" title="Criar">+</button>` : ''}</h4>${list}`;

  $('#side').innerHTML =
    sec('Canais de texto', 'text', by('text').map(c => row(c, '#')).join('')) +
    sec('Canais de voz', 'voice', by('voice').map(c => row(c, '🔊') + users(c)).join('')) +
    sec('Grupos', 'group', by('group').map(c => row(c, '👥') + users(c)).join('') || '<p class="dim pad">Crie um grupo com o +.</p>') +
    sec('Membros', '', ps.map(p => {
      const d = convs.get(dmId(p.id));
      return `<div class="it${S.cur === dmId(p.id) ? ' on' : ''}" data-dm="${p.id}" data-u="${p.id}">${avatarIcon(p.nick, p.avatar)}<span>${esc(p.nick)}</span>${p.voice === dmId(p.id) ? '📞' : ''}${d?.unread ? `<b>${d.unread}</b>` : ''}<em class="st ${p.state}"></em></div>`;
    }).join('') || '<p class="dim pad">Só você por enquanto.</p>');

  const c = convs.get(S.cur);
  const ic = { text: '#', voice: '🔊', group: '👥', dm: '@' };
  $('#head').innerHTML = c
    ? `<h2>${ic[c.type]} ${esc(title(c))}</h2>` + (c.type === 'text' ? '' : S.voice === c.id
      ? `<div class="acts">${S.share ? '<button data-unshare>Parar transmissão</button>' : '<button data-share>🖥 Compartilhar tela</button>'}<button class="bad" data-leave>Sair da voz</button></div>`
      : `<button class="go" data-join>${c.type === 'dm' ? '📞 Ligar' : 'Entrar na voz'}</button>`) +
      (c.type === 'group' && (hosting || c.owner === S.nick) ? '<button data-group-manage title="Gerenciar grupo">⚙</button>' : '')
    : '';
  $('#msgs').innerHTML = c
    ? c.msgs.map(m => `<div class="m"><i style="--h:${hue(m.n)}">${esc(m.n[0])}</i><div><b>${esc(m.n)}</b> <time>${new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time><p>${esc(m.text)}</p></div></div>`).join('') || '<p class="dim">Nenhuma mensagem ainda. Escreva a primeira.</p>'
    : '';
  $('#msgs').scrollTop = 1e9;
  $('#txt').placeholder = c ? `Mensagem para ${title(c)}` : '';

  $('#bm').classList.toggle('off', S.muted || S.deaf);
  $('#bd').classList.toggle('off', S.deaf);
  $('#bl').hidden = !S.voice;
  $('#av').style.setProperty('--h', hue(S.nick));
  $('#av').classList.toggle('photo', !!S.avatar);
  $('#av').style.backgroundImage = S.avatar ? `url("${S.avatar}")` : '';
  $('#av').textContent = S.avatar ? '' : S.nick[0] || ''; $('#mn').textContent = S.nick;
  renderStage();
  paint();
}

// ───────── Eventos ─────────
function selectMode(next) {
  mode = next;
  document.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('on', x.dataset.tab === mode));
  const host = mode === 'host';
  $('#addr').hidden = host; $('#addr').required = !host;
  $('#pname').hidden = !host; $('#pname').required = host; $('#port').hidden = !host;
  $('#go').textContent = host ? 'Abrir party' : 'Entrar';
}
document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => selectMode(b.dataset.tab));

$('#lf').onsubmit = async e => {
  e.preventDefault();
  ac ||= new AudioContext(); ac.resume();
  $('#err').textContent = ''; $('#go').disabled = true;
  S.nick = $('#nick').value.trim();
  bridge.persistence.saveProfile({ nick: S.nick }).catch(() => {});
  const pass = $('#pass').value;
  let addr = $('#addr').value.trim();
  if (mode === 'host') {
    const port = Number($('#port').value) || 7777;
    const r = await bridge.start({ port, name: $('#pname').value.trim(), password: pass, ownerDevice: deviceId });
    if (!r.ok) { $('#go').disabled = false; return ($('#err').textContent = r.error); }
    hosting = true; restoreHistory(r.history); S.invite = r.ips.map(i => `${i.ip}:${port}`); addr = '127.0.0.1:' + port;
  }
  connect(addr, S.nick, pass);
};

$('#side').onclick = e => {
  const t = e.target.closest('[data-c],[data-dm],[data-new]'); if (!t) return;
  if (t.dataset.new) return ask(t.dataset.new);
  if (t.dataset.dm) return open(dmConv(t.dataset.dm).id);
  open(t.dataset.c);
  const c = convs.get(t.dataset.c);
  if (c.type === 'voice' && S.voice !== c.id) joinVoice(c.id);
};
$('#head').onclick = e => {
  if (e.target.closest('[data-join]')) joinVoice(S.cur);
  if (e.target.closest('[data-leave]')) leaveVoice();
  if (e.target.closest('[data-share]')) pickScreen();
  if (e.target.closest('[data-unshare]')) stopShare();
  if (e.target.closest('[data-group-manage]')) manageGroup();
};
$('#stage').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  const d = b.dataset;
  if (d.watch) watchOn(d.watch, true);
  else if (d.unwatch) watchOn(d.unwatch, false);
  else if (d.float) floatScreen(d.float);
  else if ('unshare' in d) stopShare();
};
$('#bm').onclick = () => { S.muted = !S.muted; announce(); apply(); render(); };
$('#bd').onclick = () => { S.deaf = !S.deaf; announce(); apply(); render(); };
$('#bl').onclick = leaveVoice;
$('#txt').onkeydown = e => { if (e.key === 'Enter') { say(e.target.value); e.target.value = ''; } };
$('#login-settings').onclick = openSettings;
$('#floating-close').onclick = closeFloating;
$('#floating-full').onclick = () => fullScreen(peers.get(floatingPeer));
const floatingPanel = $('#floating-screen');
const resizeCursor = { n: 'n-resize', s: 's-resize', e: 'e-resize', w: 'w-resize', ne: 'ne-resize', nw: 'nw-resize', se: 'se-resize', sw: 'sw-resize' };
function floatingResizeDirection(event) {
  if (floatingPanel.classList.contains('floating-maximized')) return '';
  const rect = floatingPanel.getBoundingClientRect(), edge = 10;
  const vertical = event.clientY - rect.top < edge ? 'n' : rect.bottom - event.clientY < edge ? 's' : '';
  const horizontal = event.clientX - rect.left < edge ? 'w' : rect.right - event.clientX < edge ? 'e' : '';
  return vertical + horizontal;
}
function clearFloatingCursor() {
  delete floatingPanel.dataset.resizeDirection;
  floatingPanel.style.cursor = '';
}
floatingPanel.addEventListener('pointermove', event => {
  if (event.buttons) return;
  const direction = floatingResizeDirection(event);
  if (direction) {
    floatingPanel.dataset.resizeDirection = direction;
    floatingPanel.style.cursor = resizeCursor[direction];
  } else clearFloatingCursor();
});
floatingPanel.addEventListener('pointerleave', clearFloatingCursor);
floatingPanel.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  const direction = floatingResizeDirection(event);
  if (!direction) return;
  event.preventDefault(); event.stopPropagation();
  const start = floatingPanel.getBoundingClientRect();
  const minWidth = 300, minHeight = 200, x = event.clientX, y = event.clientY;
  const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
  const move = next => {
    const dx = next.clientX - x, dy = next.clientY - y;
    let left = start.left, top = start.top, width = start.width, height = start.height;
    if (direction.includes('w')) { left = clamp(start.left + dx, 0, start.right - minWidth); width = start.right - left; }
    if (direction.includes('e')) width = clamp(start.width + dx, minWidth, window.innerWidth - start.left);
    if (direction.includes('n')) { top = clamp(start.top + dy, 0, start.bottom - minHeight); height = start.bottom - top; }
    if (direction.includes('s')) height = clamp(start.height + dy, minHeight, window.innerHeight - start.top);
    floatingPanel.style.left = `${left}px`; floatingPanel.style.top = `${top}px`;
    floatingPanel.style.width = `${width}px`; floatingPanel.style.height = `${height}px`;
    floatingPanel.style.right = 'auto'; floatingPanel.style.bottom = 'auto';
  };
  const end = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); clearFloatingCursor(); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', end);
}, true);
$('#floating-screen-title').onpointerdown = e => {
  if (e.button !== 0 || floatingPanel.classList.contains('floating-maximized') || floatingResizeDirection(e)) return;
  const panel = floatingPanel, start = panel.getBoundingClientRect();
  const left = start.left, top = start.top, x = e.clientX, y = e.clientY;
  const move = event => {
    panel.style.left = `${Math.min(Math.max(0, left + event.clientX - x), window.innerWidth - start.width)}px`;
    panel.style.top = `${Math.min(Math.max(0, top + event.clientY - y), window.innerHeight - start.height)}px`;
    panel.style.right = 'auto'; panel.style.bottom = 'auto';
  };
  const end = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', end);
};
bridge.update.onProgress(progress => {
  if (U.state === 'downloading') { U.progress = progress; renderUpdateSettings(); }
});
$('#recent-list').onclick = e => {
  const button = e.target.closest('[data-recent]');
  if (button) joinRecent(Number(button.dataset.recent));
};

async function restoreLocalParty() {
  try {
    const saved = await bridge.persistence.load();
    $('#nick').value = saved.profile?.nick || '';
    S.avatar = await bridge.profile.photo();
    renderRecentParties(saved.recent);
    if (!saved.party) return;
    $('#pname').value = saved.party.name || '';
    $('#port').value = saved.party.port || 7777;
    $('#pass').value = saved.party.password || '';
    selectMode('host');
    $('#go').textContent = 'Abrir party salva';
  } catch {}
}
restoreLocalParty();
