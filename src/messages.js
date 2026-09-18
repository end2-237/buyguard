'use strict';

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
  const lines = [];
  lines.push('🚨 VIGILE BUYTICLE — ALERTE ADMIN');
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
  lines.push(`Heure : ${new Date().toISOString()}`);
  return lines.join('\n');
}

module.exports = { CLIENT_MESSAGES, clientMessage, clientTypes, adminAlertText };
