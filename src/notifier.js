'use strict';

// Aiguillage des envois : ADMIN (vérité) vs CLIENTS (rassurance).
// TOUS les envois passent par le gouverneur `guard` (protection facturation).
const { config } = require('./config');
const db = require('./db');
const wa = require('./whatsapp');
const guard = require('./guard');
const { adminAlertText, clientMessage } = require('./messages');

function maskPhone(p) {
  if (!p || p.length < 4) return '****';
  return p.slice(0, 3) + '****' + p.slice(-2);
}

// Envoi brut à une liste de destinataires (sans gouverneur). Usage interne.
async function rawSend(recipients, buildOpts) {
  const results = [];
  for (const to of recipients) {
    const r = await wa.sendResilient(to, buildOpts(to));
    results.push({ to: maskPhone(to), ok: r.ok, mode: r.mode, error: r.error });
    if (!r.ok) console.error(`[notifier] ${maskPhone(to)} échec: ${r.error}`);
  }
  return results;
}

// Point de passage unique : applique la décision du gouverneur puis envoie.
// meta: { category, text, isCritical, bypassDedup }
async function dispatch(recipients, buildOpts, meta) {
  if (!recipients || recipients.length === 0) {
    return { skipped: true, reason: 'no_recipients' };
  }
  const decision = guard.evaluate({
    category: meta.category,
    text: meta.text,
    isCritical: !!meta.isCritical,
    recipientCount: recipients.length,
    bypassDedup: !!meta.bypassDedup,
  });

  if (decision.action === 'skip') {
    console.log(`[guard] envoi ignoré (${decision.reason}) — ${meta.category}`);
    return { skipped: true, reason: decision.reason };
  }

  if (decision.action === 'defer') {
    console.log(`[guard] alerte regroupée (quiet hours) — ${meta.category}`);
    return { deferred: true, reason: decision.reason };
  }

  if (decision.action === 'trip') {
    // Coupe-circuit : un unique message d'avertissement aux admins.
    console.warn('[guard] COUPE-CIRCUIT horaire — suspension 1h');
    const results = await rawSend(config.ADMIN_NUMBERS, () => ({
      text: decision.suspensionText,
      fallbackTemplate: config.ADMIN_ALERT_TEMPLATE,
      fallbackParam: decision.suspensionText,
    }));
    guard.recordSends(config.ADMIN_NUMBERS.length);
    return { suspended: true, results };
  }

  // action === 'send'
  const results = await rawSend(recipients, buildOpts);
  guard.recordSends(recipients.length);
  return { results };
}

// Alerte détaillée aux admins (avec boutons).
async function notifyAdmins(alert, opts = {}) {
  const text = adminAlertText(alert);
  const buttons = [
    { id: 'view_status', title: 'Voir état' },
    { id: 'how_to_cut', title: 'Comment couper' },
  ];
  return dispatch(
    config.ADMIN_NUMBERS,
    () => ({
      text,
      buttons,
      fallbackTemplate: config.ADMIN_ALERT_TEMPLATE,
      fallbackParam: `${alert.title} — ${alert.value || ''}`.trim(),
    }),
    { category: 'alert', text, isCritical: !!opts.isCritical }
  );
}

// Message texte aux admins (démarrage, test, résolutions, récap).
async function notifyAdminsText(text, buttons, opts = {}) {
  return dispatch(
    config.ADMIN_NUMBERS,
    () => ({
      text,
      buttons,
      fallbackTemplate: config.ADMIN_ALERT_TEMPLATE,
      fallbackParam: text,
    }),
    {
      category: opts.category || 'system',
      text,
      isCritical: opts.isCritical !== undefined ? opts.isCritical : true,
      bypassDedup: opts.bypassDedup !== undefined ? opts.bypassDedup : true,
    }
  );
}

// Broadcast rassurant aux clients (déclenché manuellement, déjà validé côté route).
async function notifyClients(type) {
  const text = clientMessage(type);
  if (!text) throw new Error(`Type de message client inconnu: ${type}`);
  const clients = db.listClients();
  const recipients = clients.map((c) => c.phone);
  const res = await dispatch(recipients, () => ({
    text,
    fallbackTemplate: config.CLIENT_MSG_TEMPLATE,
    fallbackParam: text,
  }), { category: 'client', text, isCritical: false, bypassDedup: true });
  return { type, count: recipients.length, ...res };
}

// Envoyée à chaque tick de monitoring : si on quitte les quiet hours,
// envoie UN récapitulatif groupé des alertes retenues.
async function flushDeferred() {
  const items = guard.takeDeferredIfExiting();
  if (!items || !items.length) return null;
  const text =
    '🌙 Récapitulatif des alertes (heures calmes) :\n\n' + items.join('\n\n');
  await notifyAdminsText(text, undefined, {
    category: 'alert',
    isCritical: true,
    bypassDedup: true,
  });
  return items.length;
}

module.exports = {
  notifyAdmins,
  notifyAdminsText,
  notifyClients,
  flushDeferred,
  maskPhone,
};
