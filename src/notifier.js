'use strict';

// Aiguillage des envois : ADMIN (vérité) vs CLIENTS (rassurance).
const { config } = require('./config');
const db = require('./db');
const wa = require('./whatsapp');
const { adminAlertText, clientMessage } = require('./messages');

// Envoie une alerte détaillée à tous les admins, avec boutons interactifs.
async function notifyAdmins(alert) {
  const text = adminAlertText(alert);
  const buttons = [
    { id: 'view_status', title: 'Voir état' },
    { id: 'how_to_cut', title: 'Comment couper' },
  ];
  const results = [];
  for (const to of config.ADMIN_NUMBERS) {
    const r = await wa.sendResilient(to, {
      text,
      buttons,
      fallbackTemplate: config.ADMIN_ALERT_TEMPLATE,
      fallbackParam: `${alert.title} — ${alert.value || ''}`.trim(),
    });
    results.push({ to, ok: r.ok, mode: r.mode, error: r.error });
    if (!r.ok) console.error(`[notifier] admin ${maskPhone(to)} échec: ${r.error}`);
  }
  return results;
}

// Message texte simple aux admins (ex. message de démarrage avec boutons).
async function notifyAdminsText(text, buttons) {
  const results = [];
  for (const to of config.ADMIN_NUMBERS) {
    const r = await wa.sendResilient(to, {
      text,
      buttons,
      fallbackTemplate: config.ADMIN_ALERT_TEMPLATE,
      fallbackParam: text,
    });
    results.push({ to, ok: r.ok, mode: r.mode, error: r.error });
  }
  return results;
}

// Broadcast rassurant à tous les clients.
async function notifyClients(type) {
  const text = clientMessage(type);
  if (!text) throw new Error(`Type de message client inconnu: ${type}`);
  const clients = db.listClients();
  const results = [];
  for (const c of clients) {
    const r = await wa.sendResilient(c.phone, {
      text,
      fallbackTemplate: config.CLIENT_MSG_TEMPLATE,
      fallbackParam: text,
    });
    results.push({ to: c.phone, ok: r.ok, mode: r.mode, error: r.error });
    if (!r.ok) console.error(`[notifier] client ${maskPhone(c.phone)} échec: ${r.error}`);
  }
  return { type, count: clients.length, results };
}

function maskPhone(p) {
  if (!p || p.length < 4) return '****';
  return p.slice(0, 3) + '****' + p.slice(-2);
}

module.exports = { notifyAdmins, notifyAdminsText, notifyClients, maskPhone };
