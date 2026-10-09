const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const nickKey = nick => String(nick || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
const validDevice = value => /^[a-z0-9_-]{8,100}$/i.test(String(value || '').trim());
const cleanAvatar = value => {
  const avatar = String(value || '');
  return avatar.length <= 14 * 1024 * 1024 && /^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(avatar) ? avatar : null;
};
const memberKey = (device, nick) => {
  const value = String(device || '').trim();
  return validDevice(value) ? `device:${value}` : nickKey(nick);
};

// Sinalização da party: autentica com a senha, apresenta os membros uns aos
// outros e guarda a lista de canais. Voz e mensagens NUNCA passam por aqui:
// vão direto entre os peers via WebRTC.
function startServer({ port, name, password, channels: savedChannels, memberHistory: savedMembers, history: savedHistory, ownerDevice, onChannelsChange, onMembersChange }) {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port });
    const peers = new Map();
    const members = new Map();
    const ownerKey = memberKey(ownerDevice, '');
    const defaults = [
      { id: 'c-geral', type: 'text', name: 'geral', restricted: false, access: [] },
      { id: 'c-voz', type: 'voice', name: 'Sala de voz', restricted: false, access: [] },
    ];
    const cleanChannel = ch => ({
      id: String(ch?.id || '').slice(0, 40),
      type: ['text', 'voice'].includes(ch?.type) ? ch.type : 'text',
      name: String(ch?.name || '').slice(0, 30),
      restricted: !!ch?.restricted,
      access: Array.isArray(ch?.access) ? [...new Set(ch.access.map(key => String(key).slice(0, 80)).filter(Boolean))] : [],
    });
    const channels = savedChannels?.length ? savedChannels.map(cleanChannel).filter(ch => ch.id && ch.name) : defaults;
    let history = Array.isArray(savedHistory) ? savedHistory : [];
    const send = (ws, m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
    const all = (m, except) => peers.forEach((p, id) => id !== except && send(p.ws, m));
    const channelHistory = () => history.filter(conversation => ['text', 'voice'].includes(conversation?.type));
    for (const member of Array.isArray(savedMembers) ? savedMembers : []) {
      const nick = String(member?.nick || '').trim().replace(/\s+/g, ' ').slice(0, 24);
      const key = String(member?.key || nickKey(nick)).slice(0, 80);
      if (key) members.set(key, {
        key, nick, banned: !!member.banned, role: key === ownerKey || member.role === 'admin' ? 'admin' : 'member',
        avatar: cleanAvatar(member.avatar),
        firstSeen: Number(member.firstSeen) || Date.now(),
        lastSeen: Number(member.lastSeen) || Date.now(),
      });
    }
    const memberList = () => {
      const online = new Set([...peers.values()].map(peer => peer.key));
      return [...members.values()]
        .map(member => ({ ...member, owner: member.key === ownerKey, online: online.has(member.key) }))
        .sort((a, b) => b.lastSeen - a.lastSeen);
    };
    const isAdmin = peer => !!peer && members.get(peer.key)?.role === 'admin';
    const sendAdminMembers = () => {
      const list = memberList();
      peers.forEach(peer => { if (isAdmin(peer)) send(peer.ws, { t: 'admin-members', members: list }); });
    };
    const saveMembers = () => { onMembersChange?.([...members.values()]); sendAdminMembers(); };
    const channelList = () => channels.map(channel => ({ ...channel, access: [...channel.access] }));
    const updateChannel = (id, changes = {}) => {
      const index = channels.findIndex(channel => channel.id === String(id || ''));
      if (index < 0) return null;
      const current = channels[index];
      const next = cleanChannel({
        ...current,
        name: changes.name === undefined ? current.name : changes.name,
        restricted: changes.restricted === undefined ? current.restricted : changes.restricted,
        access: changes.access === undefined ? current.access : changes.access,
      });
      if (!next.name) return null;
      channels[index] = next;
      onChannelsChange?.(channelList());
      all({ t: 'channel-update', ch: next });
      return next;
    };
    const removeChannel = id => {
      const index = channels.findIndex(channel => channel.id === String(id || ''));
      if (index < 0) return false;
      const [channel] = channels.splice(index, 1);
      onChannelsChange?.(channelList());
      all({ t: 'channel-remove', id: channel.id });
      return true;
    };
    const disconnectMember = (key, message) => {
      [...peers.values()].filter(peer => peer.key === key).forEach(peer => {
        send(peer.ws, { t: 'error', msg: message });
        peer.ws.close();
      });
    };
    const kickMember = key => {
      const member = members.get(String(key || ''));
      if (!member || member.key === ownerKey) return memberList();
      member.lastSeen = Date.now();
      saveMembers();
      disconnectMember(member.key, 'Você foi removido desta party pelo anfitrião.');
      return memberList();
    };
    const removeMember = key => {
      const member = members.get(String(key || ''));
      if (!member || member.key === ownerKey) return memberList();
      members.delete(member.key);
      saveMembers();
      disconnectMember(member.key, 'Você foi removido desta party pelo anfitrião.');
      return memberList();
    };
    const banMember = key => {
      const member = members.get(String(key || ''));
      if (!member || member.key === ownerKey) return memberList();
      member.banned = true;
      member.lastSeen = Date.now();
      saveMembers();
      disconnectMember(member.key, 'Você foi banido desta party pelo anfitrião.');
      return memberList();
    };
    const unbanMember = key => {
      const member = members.get(String(key || ''));
      if (!member || member.key === ownerKey) return memberList();
      member.banned = false;
      saveMembers();
      return memberList();
    };
    const setMemberRole = (key, role) => {
      const member = members.get(String(key || ''));
      if (!member || member.key === ownerKey) return memberList();
      member.role = role === 'admin' ? 'admin' : 'member';
      saveMembers();
      [...peers.values()].filter(peer => peer.key === member.key)
        .forEach(peer => send(peer.ws, { t: 'permission', role: member.role }));
      return memberList();
    };
    const adminAction = (peer, action, key) => {
      if (!isAdmin(peer)) return send(peer.ws, { t: 'error', msg: 'Você não tem permissão para gerenciar a party.' });
      const member = members.get(String(key || ''));
      if (!member) return;
      if (member.role === 'admin') return send(peer.ws, { t: 'error', msg: 'Administradores só podem ser alterados pelo anfitrião.' });
      ({ remove: removeMember, ban: banMember, unban: unbanMember }[action] || (() => {}))(member.key);
    };

    wss.on('error', reject);
    wss.once('listening', () =>
      resolve({
        close: () => { wss.clients.forEach(c => c.terminate()); wss.close(); },
        members: memberList, kick: kickMember, remove: removeMember, ban: banMember, unban: unbanMember, setRole: setMemberRole,
        channels: channelList, updateChannel, removeChannel,
        setHistory: nextHistory => { history = Array.isArray(nextHistory) ? nextHistory : []; },
      }));

    wss.on('connection', ws => {
      let id = null;
      ws.on('message', raw => {
        let m; try { m = JSON.parse(raw); } catch { return; }
        if (!id) {
          if (m.t !== 'join') return ws.close();
          if (m.password !== password) { send(ws, { t: 'error', msg: 'Senha incorreta.' }); return ws.close(); }
          id = crypto.randomBytes(4).toString('hex');
          const nick = String(m.nick || 'Anônimo').trim().replace(/\s+/g, ' ').slice(0, 24);
          if (!validDevice(m.device)) {
            send(ws, { t: 'error', msg: 'Não foi possível identificar esta instalação. Atualize o aplicativo e tente novamente.' });
            return ws.close();
          }
          const key = memberKey(m.device, nick);
          let prior = members.get(key);
          const sameNickname = [...members.values()].find(member => nickKey(member.nick) === nickKey(nick));
          if (prior && nickKey(prior.nick) !== nickKey(nick)) {
            send(ws, { t: 'error', msg: `Este GUID está vinculado ao usuário "${prior.nick}".` });
            return ws.close();
          }
          if (sameNickname && sameNickname.key !== key) {
            if (sameNickname.key !== nickKey(nick)) {
              send(ws, { t: 'error', msg: 'Este nome de usuário já está vinculado a outro GUID nesta party.' });
              return ws.close();
            }
            prior = sameNickname;
          }
          if (prior?.banned) {
            send(ws, { t: 'error', msg: 'Este apelido foi banido desta party.' });
            return ws.close();
          }
          if ([...peers.values()].some(peer => nickKey(peer.nick) === nickKey(nick))) {
            send(ws, { t: 'error', msg: 'Esse apelido já está em uso nesta party. Escolha outro.' });
            return ws.close();
          }
          const avatar = cleanAvatar(m.avatar) || prior?.avatar || null;
          send(ws, { t: 'welcome', id, party: name, role: key === ownerKey ? 'admin' : prior?.role || 'member', memberKey: key, channels, history: channelHistory(), members: [...peers].map(([i, p]) => ({ id: i, nick: p.nick, avatar: p.avatar || null })) });
          if (prior?.key !== key) members.delete(prior?.key);
          members.set(key, { key, nick, banned: false, role: key === ownerKey ? 'admin' : prior?.role || 'member', avatar, firstSeen: prior?.firstSeen || Date.now(), lastSeen: Date.now() });
          saveMembers();
          peers.set(id, { ws, nick, key, avatar });
          sendAdminMembers();
          all({ t: 'peer-join', id, nick, avatar }, id);
        } else if (m.t === 'signal' && peers.has(m.to)) {
          send(peers.get(m.to).ws, { t: 'signal', from: id, data: m.data });
        } else if (m.t === 'channel-add' && ['text', 'voice'].includes(m.type)) {
          const ch = cleanChannel({ id: 'c-' + crypto.randomBytes(3).toString('hex'), type: m.type, name: m.name, restricted: false, access: [] });
          if (!ch.name) return;
          channels.push(ch); onChannelsChange?.(channelList());
          all({ t: 'channel-add', ch });
        } else if (m.t === 'admin-members' && isAdmin(peers.get(id))) {
          send(ws, { t: 'admin-members', members: memberList() });
        } else if (m.t === 'admin-action') {
          adminAction(peers.get(id), m.action, m.key);
        } else if (m.t === 'profile-avatar') {
          const peer = peers.get(id); if (!peer) return;
          const avatar = cleanAvatar(m.avatar);
          peer.avatar = avatar;
          if (members.has(peer.key)) members.get(peer.key).avatar = avatar;
          saveMembers();
          all({ t: 'peer-avatar', id, avatar }, id);
        }
      });
      ws.on('close', () => {
        if (!id) return;
        const peer = peers.get(id);
        peers.delete(id);
        if (peer && members.has(peer.key)) {
          members.get(peer.key).lastSeen = Date.now();
          saveMembers();
        }
        all({ t: 'peer-leave', id });
      });
    });
  });
}

module.exports = { startServer };
