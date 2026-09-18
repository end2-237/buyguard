'use strict';

// Chargement optionnel d'un fichier .env (sans dépendance) pour le dev local.
// En production (Coolify), les variables sont injectées par la plateforme.
const fs = require('fs');
const path = require('path');

(function loadDotEnv() {
  try {
    const envPath = path.join(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) return;
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch (_) {
    // silencieux : le .env est optionnel
  }
})();

function num(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function list(name) {
  const v = process.env[name];
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const config = {
  PORT: num('PORT', 3000),

  // WhatsApp Cloud API
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN || '',
  PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID || '',
  GRAPH_VERSION: process.env.GRAPH_VERSION || 'v26.0',

  // Numéros
  ADMIN_NUMBERS: list('ADMIN_NUMBERS'),

  // Sécurité API
  ADMIN_API_TOKEN: process.env.ADMIN_API_TOKEN || '',

  // Monitoring
  CRITICAL_CONTAINERS: list('CRITICAL_CONTAINERS'),
  STEAL_MAX: num('STEAL_MAX', 40),
  RAM_MAX: num('RAM_MAX', 92),
  DISK_MAX: num('DISK_MAX', 88),
  COOLDOWN_SEC: num('COOLDOWN_SEC', 900), // 15 min
  MONITOR_INTERVAL_SEC: num('MONITOR_INTERVAL_SEC', 30),

  // Templates de secours (livraison hors fenêtre 24h)
  ADMIN_ALERT_TEMPLATE: process.env.ADMIN_ALERT_TEMPLATE || '',
  CLIENT_MSG_TEMPLATE: process.env.CLIENT_MSG_TEMPLATE || '',
  TEMPLATE_LANG: process.env.TEMPLATE_LANG || 'fr',

  // Notice auto clients (0 = désactivé)
  AUTO_CLIENT_NOTICE_MIN: num('AUTO_CLIENT_NOTICE_MIN', 0),

  // Protection facturation (anti-rafale)
  MAX_MSG_PER_DAY: num('MAX_MSG_PER_DAY', 30),
  MAX_MSG_PER_HOUR: num('MAX_MSG_PER_HOUR', 6),
  CLIENT_BROADCAST_COOLDOWN: num('CLIENT_BROADCAST_COOLDOWN', 3600),
  QUIET_HOURS: process.env.QUIET_HOURS || '', // ex. "23-6" ; vide = désactivé

  // Stockage persistant
  DATA_DIR: process.env.DATA_DIR || '/data',

  // IP publique du serveur (auto-détectée si vide)
  SERVER_PUBLIC_IP: process.env.SERVER_PUBLIC_IP || '',

  // Plages réseau à ignorer (préfixes) en plus des plages Meta/WhatsApp et privées.
  EXTRA_ALLOWED_PREFIXES: list('EXTRA_ALLOWED_PREFIXES'),
};

// Plages Meta/WhatsApp à ignorer pour la détection C2/botnet.
config.META_PREFIXES = ['57.144.', '31.13.', '157.240.', '179.60.', '129.134.'];

function validate() {
  const problems = [];
  if (!config.WHATSAPP_TOKEN) problems.push('WHATSAPP_TOKEN manquant');
  if (!config.PHONE_NUMBER_ID) problems.push('PHONE_NUMBER_ID manquant');
  if (!config.ADMIN_API_TOKEN) problems.push('ADMIN_API_TOKEN manquant');
  if (config.ADMIN_NUMBERS.length === 0) problems.push('ADMIN_NUMBERS vide');
  return problems;
}

module.exports = { config, validate };
