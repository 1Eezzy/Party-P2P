const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

let state = null;
const emptyState = () => ({ profile: { nick: '', avatar: '' }, party: null, history: [], recent: [] });
const file = () => path.join(app.getPath('userData'), 'party-p2p.json');

function load() {
  if (state) return state;
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'));
    state = { ...emptyState(), ...parsed, profile: { ...emptyState().profile, ...(parsed.profile || {}) } };
  } catch { state = emptyState(); }
  return state;
}

function save() {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(load()), 'utf8');
}

function protect(value) {
  if (!value || !safeStorage.isEncryptionAvailable()) return null;
  return safeStorage.encryptString(value).toString('base64');
}

function reveal(value) {
  try { return value ? safeStorage.decryptString(Buffer.from(value, 'base64')) : ''; }
  catch { return ''; }
}

function publicParty() {
  const party = load().party;
  return party && { name: party.name, port: party.port, password: reveal(party.password) };
}

function cleanChannels(channels) {
  return Array.isArray(channels) ? channels
    .filter(ch => ['text', 'voice'].includes(ch?.type))
    .map(ch => ({
      id: String(ch.id).slice(0, 40), type: ch.type, name: String(ch.name).slice(0, 30),
      restricted: !!ch.restricted,
      access: Array.isArray(ch.access) ? [...new Set(ch.access.map(key => String(key).slice(0, 80)).filter(Boolean))] : [],
    }))
    .filter(ch => ch.id && ch.name) : [];
}

function cleanHistory(history) {
  return Array.isArray(history) ? history.slice(-100).map(conv => ({
    id: String(conv.id || '').slice(0, 80),
    type: ['text', 'voice', 'group', 'dm'].includes(conv.type) ? conv.type : 'text',
    name: String(conv.name || '').slice(0, 30),
    peer: String(conv.peer || '').slice(0, 40),
    members: Array.isArray(conv.members) ? conv.members.map(id => String(id).slice(0, 40)).slice(0, 100) : [],
    msgs: Array.isArray(conv.msgs) ? conv.msgs.slice(-500).map(msg => ({
      n: String(msg.n || '').slice(0, 24), text: String(msg.text || '').slice(0, 2000), ts: Number(msg.ts) || Date.now(),
    })) : [],
  })).filter(conv => conv.id) : [];
}

function cleanMembers(members) {
  return Array.isArray(members) ? members.slice(-500).map(member => ({
    key: String(member?.key || '').slice(0, 80),
    nick: String(member?.nick || '').trim().replace(/\s+/g, ' ').slice(0, 24),
    banned: !!member?.banned,
    role: member?.role === 'admin' ? 'admin' : 'member',
    firstSeen: Number(member?.firstSeen) || Date.now(),
    lastSeen: Number(member?.lastSeen) || Date.now(),
  })).filter(member => member.key && member.nick) : [];
}

function cleanOwnerDevice(value) {
  const device = String(value || '').trim();
  return /^[a-z0-9_-]{8,100}$/i.test(device) ? device : '';
}

function beginParty({ name, port, password, ownerDevice }) {
  const saved = load();
  const continuing = !!saved.party && saved.party.name === name && saved.party.port === port && reveal(saved.party.password) === password;
  const savedOwner = continuing ? cleanOwnerDevice(saved.party.ownerDevice) : '';
  if (!continuing) saved.history = [];
  saved.party = {
    name: String(name).slice(0, 30),
    port: Number(port),
    password: protect(password),
    ownerDevice: savedOwner || cleanOwnerDevice(ownerDevice),
    channels: continuing ? cleanChannels(saved.party.channels) : [],
    members: continuing ? cleanMembers(saved.party.members) : [],
  };
  save();
  return {
    channels: saved.party.channels,
    members: saved.party.members,
    ownerDevice: saved.party.ownerDevice,
    history: continuing ? cleanHistory(saved.history) : [],
  };
}

function saveChannels(channels) {
  if (!load().party) return;
  state.party.channels = cleanChannels(channels);
  save();
}

function saveMembers(members) {
  if (!load().party) return;
  state.party.members = cleanMembers(members);
  save();
}

function saveProfile(profile) {
  load().profile = { ...load().profile, nick: String(profile?.nick || '').slice(0, 24) };
  save();
}

function saveAvatar(name) {
  load().profile = { ...load().profile, avatar: String(name || '') };
  save();
}

function saveHistory(history) {
  load().history = cleanHistory(history);
  save();
}

function cleanRecent(recent) {
  return Array.isArray(recent) ? recent.slice(0, 4).map(item => ({
    name: String(item?.name || '').slice(0, 30),
    address: String(item?.address || '').slice(0, 120),
    nick: String(item?.nick || '').slice(0, 24),
    password: item?.password || null,
    lastUsed: Number(item?.lastUsed) || Date.now(),
  })).filter(item => item.name && item.address) : [];
}

function saveRecent(party) {
  const item = {
    name: String(party?.name || '').slice(0, 30),
    address: String(party?.address || '').slice(0, 120),
    nick: String(party?.nick || '').slice(0, 24),
    password: protect(String(party?.password || '')),
    lastUsed: Date.now(),
  };
  if (!item.name || !item.address) return;
  const prior = cleanRecent(load().recent).filter(saved => !(saved.name === item.name && saved.address === item.address));
  state.recent = cleanRecent([item, ...prior]);
  save();
}

function publicRecent() {
  return cleanRecent(load().recent).map(item => ({ ...item, password: reveal(item.password) }));
}

function snapshot() {
  return { profile: { ...load().profile }, party: publicParty(), recent: publicRecent() };
}

module.exports = { beginParty, publicParty, saveChannels, saveMembers, saveHistory, saveProfile, saveAvatar, saveRecent, snapshot };
