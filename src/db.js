'use strict';

// Petit stockage JSON persistant (pas de dépendance native).
// Fichier situé dans DATA_DIR (volume Coolify), ex. /data/store.json
const fs = require('fs');
const path = require('path');
const { config } = require('./config');

const FILE = path.join(config.DATA_DIR, 'store.json');

function ensureDir() {
  try {
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
  } catch (_) {
    // Si /data n'est pas montable, on retombe sur le cwd.
  }
}

function load() {
  ensureDir();
  try {
    if (fs.existsSync(FILE)) {
      return JSON.parse(fs.readFileSync(FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[db] lecture impossible, réinitialisation:', e.message);
  }
  return { clients: [] };
}

let state = load();

function persist() {
  ensureDir();
  const tmp = FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error('[db] écriture impossible:', e.message);
  }
}

// Normalise un numéro : chiffres uniquement, sans '+'.
function normalizePhone(phone) {
  if (typeof phone !== 'string') return '';
  return phone.replace(/[^\d]/g, '');
}

function listClients() {
  return state.clients.slice();
}

function addClient(phone, name) {
  const p = normalizePhone(phone);
  if (!p) throw new Error('Numéro invalide');
  const existing = state.clients.find((c) => c.phone === p);
  if (existing) {
    existing.name = name || existing.name;
    persist();
    return existing;
  }
  const client = { phone: p, name: name || '', addedAt: new Date().toISOString() };
  state.clients.push(client);
  persist();
  return client;
}

function removeClient(phone) {
  const p = normalizePhone(phone);
  const before = state.clients.length;
  state.clients = state.clients.filter((c) => c.phone !== p);
  const removed = state.clients.length !== before;
  if (removed) persist();
  return removed;
}

module.exports = {
  normalizePhone,
  listClients,
  addClient,
  removeClient,
  filePath: FILE,
};
