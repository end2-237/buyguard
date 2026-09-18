'use strict';

// Envoi WhatsApp via Meta Cloud API.
// Stratégie fenêtre 24h : on tente d'abord le message LIBRE (texte / boutons).
// Si Meta refuse pour cause de fenêtre expirée (code 131047 / 131051 / 470),
// on retombe sur un TEMPLATE approuvé si un nom de template est fourni.
const { config } = require('./config');

const API_BASE = () =>
  `https://graph.facebook.com/${config.GRAPH_VERSION}/${config.PHONE_NUMBER_ID}/messages`;

// Codes d'erreur Meta signalant que la fenêtre de 24h est fermée / message libre non délivrable.
const REENGAGEMENT_CODES = new Set([131047, 131051, 470, 131026]);

function authHeaders() {
  return {
    Authorization: `Bearer ${config.WHATSAPP_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

async function postMessage(payload) {
  if (!config.WHATSAPP_TOKEN || !config.PHONE_NUMBER_ID) {
    return { ok: false, error: 'WhatsApp non configuré (token/phone id manquant)' };
  }
  try {
    const res = await fetch(API_BASE(), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = data && data.error ? data.error : {};
      return {
        ok: false,
        status: res.status,
        code: err.code,
        error: err.message || `HTTP ${res.status}`,
        raw: data,
      };
    }
    return { ok: true, raw: data };
  } catch (e) {
    // Ne jamais logguer le token : e.message ne le contient pas.
    return { ok: false, error: e.message };
  }
}

function textPayload(to, body) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { preview_url: false, body },
  };
}

function buttonPayload(to, bodyText, buttons) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: 'reply',
          reply: { id: b.id, title: b.title.slice(0, 20) },
        })),
      },
    },
  };
}

// Template avec un seul paramètre texte dans le body (assez générique).
function templatePayload(to, templateName, bodyParam) {
  const components = [];
  if (bodyParam) {
    components.push({
      type: 'body',
      parameters: [{ type: 'text', text: String(bodyParam).slice(0, 1024) }],
    });
  }
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: config.TEMPLATE_LANG },
      components,
    },
  };
}

// Envoie un message libre, avec repli template hors fenêtre 24h.
// opts: { text, buttons, fallbackTemplate, fallbackParam }
async function sendResilient(to, opts) {
  let primary;
  if (opts.buttons && opts.buttons.length) {
    primary = buttonPayload(to, opts.text, opts.buttons);
  } else {
    primary = textPayload(to, opts.text);
  }

  const first = await postMessage(primary);
  if (first.ok) return { ...first, mode: 'free' };

  const windowClosed = first.code && REENGAGEMENT_CODES.has(Number(first.code));
  if (windowClosed && opts.fallbackTemplate) {
    const tpl = await postMessage(
      templatePayload(to, opts.fallbackTemplate, opts.fallbackParam || opts.text)
    );
    if (tpl.ok) return { ...tpl, mode: 'template' };
    return { ...tpl, mode: 'template_failed', freeError: first.error };
  }

  return { ...first, mode: 'free_failed' };
}

module.exports = {
  sendResilient,
  postMessage,
  textPayload,
  buttonPayload,
  templatePayload,
};
