'use strict';

// Gouverneur d'envois — PROTECTION FACTURATION (anti-rafale).
// Toute sortie WhatsApp passe par ici. Il applique :
//  - plafond journalier (MAX_MSG_PER_DAY)
//  - coupe-circuit horaire (MAX_MSG_PER_HOUR) avec suspension 1h
//  - déduplication de contenu (même texte dans la fenêtre COOLDOWN_SEC)
//  - quiet hours (regroupe les alertes non critiques, laisse passer le critique)
//  - cooldown des broadcasts clients (CLIENT_BROADCAST_COOLDOWN)
const { config } = require('./config');

const HOUR_MS = 3600 * 1000;

const state = {
  dayKey: dayKeyNow(),
  sentToday: 0,
  hourSends: [], // timestamps (ms) des envois de la dernière heure
  suspendedUntil: 0, // ms ; coupe-circuit actif tant que now < suspendedUntil
  recentContent: new Map(), // hash texte -> timestamp du dernier envoi
  lastClientBroadcastAt: 0,
  deferred: [], // résumés d'alertes non critiques retenues en quiet hours
  wasQuiet: false,
};

function dayKeyNow() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function rolloverDayIfNeeded() {
  const k = dayKeyNow();
  if (k !== state.dayKey) {
    state.dayKey = k;
    state.sentToday = 0;
    state.recentContent.clear();
  }
}

function pruneHour(now) {
  const cutoff = now - HOUR_MS;
  state.hourSends = state.hourSends.filter((t) => t >= cutoff);
}

function sentThisHour(now = Date.now()) {
  pruneHour(now);
  return state.hourSends.length;
}

// Parse QUIET_HOURS "23-6" -> {start:23, end:6}. Vide => null.
function parseQuiet() {
  const q = config.QUIET_HOURS;
  if (!q) return null;
  const m = String(q).match(/^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/);
  if (!m) return null;
  const start = Number(m[1]) % 24;
  const end = Number(m[2]) % 24;
  return { start, end };
}

function inQuietHours(date = new Date()) {
  const q = parseQuiet();
  if (!q) return false;
  const h = date.getHours();
  if (q.start === q.end) return false;
  if (q.start < q.end) return h >= q.start && h < q.end; // ex. 1-6
  return h >= q.start || h < q.end; // fenêtre passant minuit, ex. 23-6
}

function hashText(t) {
  // Hash léger et stable (djb2) — suffisant pour la dédup de contenu.
  let h = 5381;
  const s = String(t || '');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h);
}

function isDuplicate(text, now) {
  const h = hashText(text);
  const last = state.recentContent.get(h);
  if (last && now - last < config.COOLDOWN_SEC * 1000) return true;
  return false;
}

// Décision pour un message logique adressé à `recipientCount` destinataires.
// category: 'alert' | 'client' | 'system'
// Retourne { action, reason, suspensionText? }
//   action = 'send' | 'skip' | 'defer' | 'trip'
function evaluate({ category, text, isCritical, recipientCount, bypassDedup }) {
  const now = Date.now();
  rolloverDayIfNeeded();

  const count = Math.max(1, recipientCount || 1);

  // 1) Coupe-circuit déjà actif -> silence total.
  if (now < state.suspendedUntil) {
    return { action: 'skip', reason: 'circuit_suspended' };
  }

  // 2) Plafond journalier.
  if (state.sentToday + count > config.MAX_MSG_PER_DAY) {
    return { action: 'skip', reason: 'daily_cap' };
  }

  // 3) Déduplication de contenu.
  if (!bypassDedup && isDuplicate(text, now)) {
    return { action: 'skip', reason: 'duplicate' };
  }

  // 4) Quiet hours : les alertes non critiques sont regroupées.
  if (!isCritical && inQuietHours()) {
    state.deferred.push(text);
    return { action: 'defer', reason: 'quiet_hours' };
  }

  // 5) Coupe-circuit horaire : si cet envoi dépasse le plafond horaire,
  //    on suspend 1h et on n'envoie qu'UN message d'avertissement.
  if (sentThisHour(now) + count > config.MAX_MSG_PER_HOUR) {
    state.suspendedUntil = now + HOUR_MS;
    return {
      action: 'trip',
      reason: 'hourly_circuit',
      suspensionText:
        '⚠️ Vigile Buyticle : trop d\'alertes en 1h. Envois SUSPENDUS pendant 1h — ' +
        'vérifie le serveur. (protection facturation)',
    };
  }

  // OK pour envoyer : on mémorise le contenu pour la dédup.
  if (!bypassDedup) state.recentContent.set(hashText(text), now);
  return { action: 'send' };
}

// Enregistre l'envoi effectif de `count` messages.
function recordSends(count) {
  const now = Date.now();
  rolloverDayIfNeeded();
  const c = Math.max(1, count || 1);
  state.sentToday += c;
  for (let i = 0; i < c; i++) state.hourSends.push(now);
  pruneHour(now);
}

// Appelé à chaque tick de monitoring. Si on vient de SORTIR des quiet hours
// et que des alertes ont été retenues, renvoie le lot à envoyer (une seule fois).
function takeDeferredIfExiting() {
  const nowQuiet = inQuietHours();
  let items = null;
  if (state.wasQuiet && !nowQuiet && state.deferred.length) {
    items = state.deferred.splice(0);
  }
  state.wasQuiet = nowQuiet;
  return items;
}

// Broadcast clients : cooldown dédié.
function canClientBroadcast() {
  const now = Date.now();
  const elapsed = now - state.lastClientBroadcastAt;
  const cd = config.CLIENT_BROADCAST_COOLDOWN * 1000;
  if (state.lastClientBroadcastAt && elapsed < cd) {
    return { allowed: false, retryAfterSec: Math.ceil((cd - elapsed) / 1000) };
  }
  return { allowed: true };
}

function recordClientBroadcast() {
  state.lastClientBroadcastAt = Date.now();
}

function stats() {
  const now = Date.now();
  return {
    sentToday: state.sentToday,
    sentThisHour: sentThisHour(now),
    maxPerDay: config.MAX_MSG_PER_DAY,
    maxPerHour: config.MAX_MSG_PER_HOUR,
    suspended: now < state.suspendedUntil,
    suspendedUntil: state.suspendedUntil ? new Date(state.suspendedUntil).toISOString() : null,
    quietHours: config.QUIET_HOURS || null,
    inQuietHours: inQuietHours(),
    deferredAlerts: state.deferred.length,
    dayKey: state.dayKey,
    lastClientBroadcastAt: state.lastClientBroadcastAt
      ? new Date(state.lastClientBroadcastAt).toISOString()
      : null,
  };
}

module.exports = {
  evaluate,
  recordSends,
  takeDeferredIfExiting,
  canClientBroadcast,
  recordClientBroadcast,
  stats,
  inQuietHours,
};
