const { WebSocketServer } = require('ws');
const crypto = require('crypto');

// Sinalização da party: autentica com a senha, apresenta os membros uns aos
// outros e guarda a lista de canais. Voz e mensagens NUNCA passam por aqui:
// vão direto entre os peers via WebRTC.
function startServer({ port, name, password }) {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port });
    const peers = new Map();
    const channels = [
      { id: 'c-geral', type: 'text', name: 'geral' },
      { id: 'c-voz', type: 'voice', name: 'Sala de voz' },
    ];
    const send = (ws, m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
    const all = (m, except) => peers.forEach((p, id) => id !== except && send(p.ws, m));

    wss.on('error', reject);
    wss.once('listening', () =>
      resolve({ close: () => { wss.clients.forEach(c => c.terminate()); wss.close(); } }));

    wss.on('connection', ws => {
      let id = null;
      ws.on('message', raw => {
        let m; try { m = JSON.parse(raw); } catch { return; }
        if (!id) {
          if (m.t !== 'join') return ws.close();
          if (m.password !== password) { send(ws, { t: 'error', msg: 'Senha incorreta.' }); return ws.close(); }
          id = crypto.randomBytes(4).toString('hex');
          const nick = String(m.nick || 'Anônimo').slice(0, 24);
          send(ws, { t: 'welcome', id, party: name, channels, members: [...peers].map(([i, p]) => ({ id: i, nick: p.nick })) });
          peers.set(id, { ws, nick });
          all({ t: 'peer-join', id, nick }, id);
        } else if (m.t === 'signal' && peers.has(m.to)) {
          send(peers.get(m.to).ws, { t: 'signal', from: id, data: m.data });
        } else if (m.t === 'channel-add' && ['text', 'voice'].includes(m.type)) {
          const ch = { id: 'c-' + crypto.randomBytes(3).toString('hex'), type: m.type, name: String(m.name).slice(0, 30) };
          channels.push(ch);
          all({ t: 'channel-add', ch });
        }
      });
      ws.on('close', () => { if (id) { peers.delete(id); all({ t: 'peer-leave', id }); } });
    });
  });
}

module.exports = { startServer };
