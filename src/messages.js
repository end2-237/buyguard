'use strict';

const { config } = require('./config');

// Messages clients pré-rédigés (rassurants, sans technique).
const CLIENT_MESSAGES = {
  incident:
    'Bonjour, nos services connaissent une interruption temporaire. ' +
    'Nos équipes travaillent à un rétablissement rapide. Merci de votre patience. — Buyticle',
  maintenance:
    'Bonjour, une maintenance planifiée est en cours afin d\'améliorer nos services. ' +
    'Une brève interruption est possible. Merci de votre compréhension. — Buyticle',
  retabli:
    'Bonjour, nos services sont de nouveau pleinement opérationnels. ' +
    'Merci de votre confiance. — Buyticle',
};

function clientMessage(type) {
  return CLIENT_MESSAGES[type];
}

function clientTypes() {
  return Object.keys(CLIENT_MESSAGES);
}

// Construit le texte d'alerte ADMIN détaillé (la VÉRITÉ technique).
function adminAlertText(alert) {
  // Le bandeau "🚨 ALERTE ADMIN" est porté par le header du message interactif ;
  // ce texte alimente le body (≤ 1024).
  const lines = [];
  lines.push(`Type : ${alert.title}`);
  if (alert.value !== undefined && alert.value !== null && alert.value !== '') {
    lines.push(`Valeur : ${alert.value}`);
  }
  if (alert.detail) lines.push(`Détail : ${alert.detail}`);
  if (alert.command) {
    lines.push('');
    lines.push('Commande d\'urgence :');
    lines.push(alert.command);
  }
  lines.push('');
  if (config.VPS_URL) lines.push(`🖥️ VPS : ${config.VPS_URL}`);
  if (config.HPANEL_URL) lines.push(`📊 Hostinger : ${config.HPANEL_URL}`);
  lines.push(`Heure : ${new Date().toISOString()}`);
  // body.text ≤ 1024 (contrainte Meta).
  return lines.join('\n').slice(0, 1024);
}

// Bloc de liens utiles (VPS / Hostinger) à ajouter au corps des messages admin.
function adminLinksBlock() {
  const parts = [];
  if (config.VPS_URL) parts.push(`🖥️ VPS : ${config.VPS_URL}`);
  if (config.HPANEL_URL) parts.push(`📊 Hostinger : ${config.HPANEL_URL}`);
  return parts.join('\n');
}

module.exports = {
  CLIENT_MESSAGES,
  clientMessage,
  clientTypes,
  adminAlertText,
  adminLinksBlock,
};
