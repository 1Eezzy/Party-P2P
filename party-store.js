const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

let state = null;
const emptyState = () => ({ profile: { nick: '' }, party: null, history: [], recent: [] });
const file = () => path.join(app.getPath('userData'), 'party-p2p.json');

function load() {
  if (state) return state;
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'));
    state = { ...emptyState(), ...parsed };
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
    .map(ch => ({ id: String(ch.id).slice(0, 40), type: ch.type, name: String(ch.name).slice(0, 30) }))
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

function beginParty({ name, port, password }) {
  const saved = load();
  const continuing = !!saved.party && saved.party.name === name && saved.party.port === port && reveal(saved.party.password) === password;
  if (!continuing) saved.history = [];
  saved.party = {
    name: String(name).slice(0, 30),
    port: Number(port),
    password: protect(password),
    channels: continuing ? cleanChannels(saved.party.channels) : [],
  };
  save();
  return { channels: saved.party.channels, history: continuing ? cleanHistory(saved.history) : [] };
}

function saveChannels(channels) {
  if (!load().party) return;
  state.party.channels = cleanChannels(channels);
  save();
}

function saveProfile(profile) {
  load().profile = { nick: String(profile?.nick || '').slice(0, 24) };
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

module.exports = { beginParty, publicParty, saveChannels, saveHistory, saveProfile, saveRecent, snapshot };
