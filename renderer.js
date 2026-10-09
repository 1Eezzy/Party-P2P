// ───────── Estado ─────────
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hue = s => [...String(s)].reduce((a, c) => a + c.charCodeAt(0) * 31, 7) % 360;
const RTC = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

const S = { id: '', nick: '', party: '', invite: [], cur: null, voice: null, mic: null, share: null, q: null, muted: false, deaf: false };
const peers = new Map(), convs = new Map(), speaking = new Set(), watchers = new Map();
let ws, ac, mode = 'join', hosting = false;

// Conversas: 'text' / 'voice' (canais da party), 'group' (grupo) e 'dm' (individual).
const nickOf = id => (id === S.id ? S.nick : peers.get(id)?.nick || '?');
const dmId = pid => 'd-' + [S.id, pid].sort().join('-');
const ensure = c => (convs.has(c.id) || convs.set(c.id, { msgs: [], unread: 0, ...c }), convs.get(c.id));
const dmConv = pid => ensure({ id: dmId(pid), type: 'dm', peer: pid });
const others = c => (c.type === 'dm' ? [c.peer] : c.type === 'group' ? c.members.filter(i => i !== S.id) : [...peers.keys()]);
const title = c => (c.type === 'dm' ? nickOf(c.peer) : c.name);
const tell = (ids, m) => ids.forEach(i => { const d = peers.get(i)?.dc; if (d?.readyState === 'open') d.send(JSON.stringify(m)); });
const sig = (to, data) => ws.send(JSON.stringify({ t: 'signal', to, data }));
const vstate = () => ({ t: 'voice', c: S.voice, m: S.muted || S.deaf, s: !!S.share });
const announce = () => tell([...peers.keys()], vstate());
const QUAL = [
  { label: '720p, 30 fps', w: 1280, h: 720, fps: 30, bps: 2.5e6 },
  { label: '1080p, 30 fps', w: 1920, h: 1080, fps: 30, bps: 5e6 },
  { label: '1080p, 60 fps', w: 1920, h: 1080, fps: 60, bps: 8e6 },
];

// ───────── Conexão com o host (só sinalização) ─────────
function connect(addr, nick, password) {
  ws = new WebSocket('ws://' + (addr.includes(':') ? addr : addr + ':7777'));
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', nick, password }));
  ws.onerror = () => fail('Não foi possível conectar ao host. Confira o endereço, a porta e o firewall.');
  ws.onclose = () => S.id && toast('O host da party saiu. Quem já está conectado continua, mas ninguém novo consegue entrar.');
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.t === 'error') fail(m.msg);
    else if (m.t === 'welcome') {
      S.id = m.id; S.party = m.party;
      m.channels.forEach(ensure);
      m.members.forEach(x => addPeer(x.id, x.nick, true)); // quem chega liga para quem já está
      enter(); open(m.channels[0].id);
    }
    else if (m.t === 'peer-join') addPeer(m.id, m.nick, false);
    else if (m.t === 'peer-leave') removePeer(m.id);
    else if (m.t === 'signal') onSig(m.from, m.data);
    else if (m.t === 'channel-add') { ensure(m.ch); render(); }
  };
}
function fail(msg) {
  if (S.id) return;
  $('#err').textContent = msg; $('#go').disabled = false;
  if (hosting) { bridge.stop(); hosting = false; }
}

// ───────── Malha P2P (WebRTC): 1 conexão por par com canal de dados + áudio ─────────
function addPeer(id, nick, init) {
  const p = { id, nick, voice: null, m: false, pend: [], state: 'new', sharing: false, watch: false, watching: false, vtrack: null };
  const pc = (p.pc = new RTCPeerConnection(RTC));
  peers.set(id, p);
  pc.onicecandidate = e => e.candidate && sig(id, { ice: e.candidate });
  pc.ondatachannel = e => bind(p, e.channel);
  pc.onconnectionstatechange = () => { p.state = pc.connectionState; render(); };
  pc.ontrack = e => {
    if (e.track.kind === 'video') { p.vstream = new MediaStream([e.track]); return; }
    p.el = new Audio(); p.el.srcObject = new MediaStream([e.track]);
    p.el.play().catch(() => {}); watch(id, p.el.srcObject); apply();
  };
  if (init) {
    bind(p, pc.createDataChannel('d'));
    p.tx = pc.addTransceiver('audio', { direction: 'sendrecv' }); // o microfone entra depois, via replaceTrack
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
      p.tx = pc.getTransceivers().find(t => t.receiver.track.kind === 'audio');
      p.tx.direction = 'sendrecv';
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
    if (!c || c.type === 'dm' && m.c !== 'dm' || c.type === 'group' && !c.members.includes(p.id)) return;
    c.msgs.push({ n: p.nick, text: String(m.text).slice(0, 2000), ts: Date.now() });
    if (S.cur !== c.id) c.unread++;
    render();
  } else if (m.t === 'group') {
    if (String(m.id).startsWith('g-') && m.members?.includes(S.id) && m.members.includes(p.id))
      { ensure({ id: m.id, type: 'group', name: String(m.name).slice(0, 30), members: m.members }); render(); }
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
// Cada par já tem uma faixa de vídeo negociada. A tela só é enviada a quem pediu para assistir,
// porque cada espectador custa uma cópia do vídeo no upload de quem transmite.
async function pickScreen() {
  let list;
  try { list = await bridge.sources(); } catch { return toast('Não foi possível listar as telas.'); }
  const d = $('#dlg');
  d.className = 'wide';
  d.innerHTML = `<form method="dialog"><h3>Compartilhar tela</h3>
    <div class="srcs">${list.map((s, i) => `<label class="src"><input type="radio" name="s" value="${esc(s.id)}"${i ? '' : ' checked'}><img src="${s.thumb}" alt=""><span>${esc(s.name)}</span></label>`).join('')}</div>
    <label>Qualidade <select name="q">${QUAL.map((q, i) => `<option value="${i}">${q.label}</option>`).join('')}</select></label>
    <p class="dim">Cada pessoa que assistir usa essa banda do seu upload.</p>
    <menu><button value="ok" class="go">Transmitir</button><button value="x" formnovalidate>Cancelar</button></menu></form>`;
  d.returnValue = '';
  d.onclose = () => {
    const r = d.querySelector('[name=s]:checked');
    if (d.returnValue === 'ok' && r) startShare(r.value, QUAL[d.querySelector('[name=q]').value]);
  };
  d.showModal();
}

async function startShare(id, q) {
  try {
    await bridge.pick(id);
    const st = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: q.w, max: q.w }, height: { ideal: q.h, max: q.h }, frameRate: { ideal: q.fps, max: q.fps } }, audio: false,
    });
    S.share = st.getVideoTracks()[0]; S.q = q;
    S.share.contentHint = q.fps > 30 ? 'motion' : 'detail';
    S.share.onended = stopShare; // quando a janela some ou o Windows interrompe a captura
  } catch { return toast('Não foi possível iniciar a transmissão.'); }
  announce(); apply(); render();
}

function stopShare() {
  if (!S.share) return;
  S.share.onended = null; S.share.stop(); S.share = null;
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
  const key = [live && S.share ? 'eu' : '', ...sh.map(p => p.id + (p.watch ? 'w' : ''))].join(',');
  if (st.dataset.k === key) return;
  st.dataset.k = key;
  const tiles = [];
  const tile = html => Object.assign(document.createElement('div'), { className: 'tile', innerHTML: html });
  if (live && S.share) tiles.push(tile('<div class="ph">Você está transmitindo sua tela<button class="bad" data-unshare>Parar</button></div>'));
  sh.forEach(p => {
    if (!p.watch || !p.vstream) return tiles.push(tile(`<div class="ph"><b>${esc(p.nick)}</b> está transmitindo<button class="go" data-watch="${p.id}">Assistir</button></div>`));
    if (!p.vel) {
      p.vel = Object.assign(document.createElement('video'), { autoplay: true, muted: true });
      p.vel.ondblclick = () => p.vel.requestFullscreen();
    }
    p.vel.srcObject = p.vstream;
    const t = tile(`<span class="tl">${esc(p.nick)}</span><div class="tb"><button data-full="${p.id}">Tela cheia</button><button data-unwatch="${p.id}">Parar de assistir</button></div>`);
    t.prepend(p.vel); tiles.push(t); p.vel.play().catch(() => {});
  });
  st.replaceChildren(...tiles); st.hidden = !tiles.length;
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
  S.cur = id; convs.get(id).unread = 0; render(); $('#txt').focus();
}

function say(text) {
  const c = convs.get(S.cur); text = text.trim();
  if (!c || !text) return;
  const ts = Date.now();
  c.msgs.push({ n: S.nick, text, ts });
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
    ensure({ id, type: 'group', name: n, members });
    tell(members.filter(i => i !== S.id), { t: 'group', id, name: n, members });
    open(id);
  };
  d.showModal();
}

function toast(text, yes) {
  const d = document.createElement('div'); d.className = 'toast';
  d.innerHTML = `<span>${esc(text)}</span>${yes ? '<button class="go">Atender</button>' : ''}<button>✕</button>`;
  d.querySelector('.go')?.addEventListener('click', () => { yes(); d.remove(); });
  d.querySelector('button:last-child').onclick = () => d.remove();
  setTimeout(() => d.remove(), yes ? 25000 : 8000);
  $('#toasts').append(d);
}

// ───────── Interface ─────────
function enter() {
  $('#login').hidden = true; $('#app').hidden = false;
  $('#me').dataset.u = S.id;
  $('#ph').innerHTML = `<b>${esc(S.party)}</b><button id="leave" title="Sair da party">Sair</button>` +
    (hosting ? `<small id="inv" title="${esc(S.invite.join('  ·  '))}">Endereço p/ convidar: ${esc(S.invite[0] || 'sem rede')} (clique para copiar)</small>` : '');
  $('#leave').onclick = () => bridge.stop().finally(() => location.reload());
  if (hosting) $('#inv').onclick = () => { navigator.clipboard.writeText(S.invite[0] || ''); toast('Endereço copiado.'); };
}

function render() {
  const cs = [...convs.values()], ps = [...peers.values()];
  const by = ty => cs.filter(c => c.type === ty);
  const inCall = c => [...(S.voice === c.id ? [S.id] : []), ...ps.filter(p => p.voice === c.id).map(p => p.id)];
  const row = (c, ic) => `<div class="it${S.cur === c.id ? ' on' : ''}" data-c="${c.id}"><u>${ic}</u><span>${esc(title(c))}</span>${c.unread ? `<b>${c.unread}</b>` : ''}</div>`;
  const users = c => inCall(c).map(i => `<div class="vu" data-u="${i}"><i style="--h:${hue(nickOf(i))}">${esc(nickOf(i)[0])}</i>${esc(nickOf(i))}${(i === S.id ? S.share : peers.get(i).sharing) ? '<span class="live">Ao vivo</span>' : ''}${(i === S.id ? S.muted || S.deaf : peers.get(i).m) ? ' <s>🔇</s>' : ''}</div>`).join('');
  const sec = (t, k, list) => `<h4>${t}${k ? `<button data-new="${k}" title="Criar">+</button>` : ''}</h4>${list}`;

  $('#side').innerHTML =
    sec('Canais de texto', 'text', by('text').map(c => row(c, '#')).join('')) +
    sec('Canais de voz', 'voice', by('voice').map(c => row(c, '🔊') + users(c)).join('')) +
    sec('Grupos', 'group', by('group').map(c => row(c, '👥') + users(c)).join('') || '<p class="dim pad">Crie um grupo com o +.</p>') +
    sec('Membros', '', ps.map(p => {
      const d = convs.get(dmId(p.id));
      return `<div class="it${S.cur === dmId(p.id) ? ' on' : ''}" data-dm="${p.id}" data-u="${p.id}"><i style="--h:${hue(p.nick)}">${esc(p.nick[0])}</i><span>${esc(p.nick)}</span>${p.voice === dmId(p.id) ? '📞' : ''}${d?.unread ? `<b>${d.unread}</b>` : ''}<em class="st ${p.state}"></em></div>`;
    }).join('') || '<p class="dim pad">Só você por enquanto.</p>');

  const c = convs.get(S.cur);
  const ic = { text: '#', voice: '🔊', group: '👥', dm: '@' };
  $('#head').innerHTML = c
    ? `<h2>${ic[c.type]} ${esc(title(c))}</h2>` + (c.type === 'text' ? '' : S.voice === c.id
      ? `<div class="acts">${S.share ? '<button data-unshare>Parar transmissão</button>' : '<button data-share>🖥 Compartilhar tela</button>'}<button class="bad" data-leave>Sair da voz</button></div>`
      : `<button class="go" data-join>${c.type === 'dm' ? '📞 Ligar' : 'Entrar na voz'}</button>`)
    : '';
  $('#msgs').innerHTML = c
    ? c.msgs.map(m => `<div class="m"><i style="--h:${hue(m.n)}">${esc(m.n[0])}</i><div><b>${esc(m.n)}</b> <time>${new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time><p>${esc(m.text)}</p></div></div>`).join('') || '<p class="dim">Nenhuma mensagem ainda. Escreva a primeira.</p>'
    : '';
  $('#msgs').scrollTop = 1e9;
  $('#txt').placeholder = c ? `Mensagem para ${title(c)}` : '';

  $('#bm').classList.toggle('off', S.muted || S.deaf);
  $('#bd').classList.toggle('off', S.deaf);
  $('#bl').hidden = !S.voice;
  $('#av').style.setProperty('--h', hue(S.nick)); $('#av').textContent = S.nick[0] || ''; $('#mn').textContent = S.nick;
  renderStage();
  paint();
}

// ───────── Eventos ─────────
document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
  mode = b.dataset.tab;
  document.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('on', x === b));
  const host = mode === 'host';
  $('#addr').hidden = host; $('#addr').required = !host;
  $('#pname').hidden = !host; $('#pname').required = host; $('#port').hidden = !host;
  $('#go').textContent = host ? 'Criar e entrar' : 'Entrar';
});

$('#lf').onsubmit = async e => {
  e.preventDefault();
  ac ||= new AudioContext(); ac.resume();
  $('#err').textContent = ''; $('#go').disabled = true;
  S.nick = $('#nick').value.trim();
  const pass = $('#pass').value;
  let addr = $('#addr').value.trim();
  if (mode === 'host') {
    const port = Number($('#port').value) || 7777;
    const r = await bridge.start({ port, name: $('#pname').value.trim(), password: pass });
    if (!r.ok) { $('#go').disabled = false; return ($('#err').textContent = r.error); }
    hosting = true; S.invite = r.ips.map(i => `${i.ip}:${port}`); addr = '127.0.0.1:' + port;
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
};
$('#stage').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  const d = b.dataset;
  if (d.watch) watchOn(d.watch, true);
  else if (d.unwatch) watchOn(d.unwatch, false);
  else if (d.full) peers.get(d.full)?.vel?.requestFullscreen();
  else if ('unshare' in d) stopShare();
};
$('#bm').onclick = () => { S.muted = !S.muted; announce(); apply(); render(); };
$('#bd').onclick = () => { S.deaf = !S.deaf; announce(); apply(); render(); };
$('#bl').onclick = leaveVoice;
$('#txt').onkeydown = e => { if (e.key === 'Enter') { say(e.target.value); e.target.value = ''; } };
