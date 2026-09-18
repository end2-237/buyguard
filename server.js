'use strict';

const express = require('express');
const { config, validate } = require('./src/config');
const db = require('./src/db');
const monitor = require('./src/monitor');
const notifier = require('./src/notifier');
const guard = require('./src/guard');
const { clientTypes, adminLinksBlock } = require('./src/messages');

const app = express();
app.use(express.json({ limit: '256kb' }));

// --- Auth middleware pour /api/* : header x-admin-token == ADMIN_API_TOKEN ---
function requireAdmin(req, res, next) {
  const token = req.get('x-admin-token');
  if (!config.ADMIN_API_TOKEN) {
    return res.status(503).json({ error: 'ADMIN_API_TOKEN non configuré' });
  }
  if (!token || token !== config.ADMIN_API_TOKEN) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  next();
}

// --- Santé (public) ---
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'vigile-buyticle',
    ts: new Date().toISOString(),
    lastCheck: monitor.lastState.ts,
    majorIncident: monitor.isMajorIncident(),
    checks: {
      cpuSteal: monitor.lastState.cpuSteal,
      ramPct: monitor.lastState.ramPct,
      diskPct: monitor.lastState.diskPct,
      suspiciousConnections: monitor.lastState.suspiciousConnections.length,
      stoppedCriticalContainers: monitor.lastState.stoppedCriticalContainers,
      suspiciousCron: !!monitor.lastState.suspiciousCron,
    },
  });
});

// Toutes les routes /api/* sont protégées.
app.use('/api', requireAdmin);

// --- État serveur complet (vérité admin) ---
app.get('/api/status', (req, res) => {
  res.json({
    ts: monitor.lastState.ts,
    cpuSteal: monitor.lastState.cpuSteal,
    ramPct: monitor.lastState.ramPct,
    diskPct: monitor.lastState.diskPct,
    suspiciousConnections: monitor.lastState.suspiciousConnections,
    stoppedCriticalContainers: monitor.lastState.stoppedCriticalContainers,
    suspiciousCron: monitor.lastState.suspiciousCron,
    errors: monitor.lastState.errors,
    thresholds: {
      STEAL_MAX: config.STEAL_MAX,
      RAM_MAX: config.RAM_MAX,
      DISK_MAX: config.DISK_MAX,
    },
    // Protection facturation : conso de messages visible.
    messaging: guard.stats(),
  });
});

// --- Broadcast clients (rassurance) ---
app.post('/api/broadcast', async (req, res) => {
  const body = req.body || {};
  const type = body.type;
  if (!type || !clientTypes().includes(type)) {
    return res
      .status(400)
      .json({ error: `type requis parmi: ${clientTypes().join(', ')}` });
  }

  const recipientCount = db.listClients().length;

  // Sécurité anti-facture : confirmation explicite exigée, avec aperçu du
  // nombre de destinataires. Sans "confirm": true, on ne fait qu'informer.
  if (body.confirm !== true) {
    return res.status(400).json({
      error: 'Confirmation requise',
      needConfirm: true,
      type,
      recipientCount,
      hint: 'Renvoyez la requête avec "confirm": true pour envoyer.',
    });
  }

  // Cooldown dédié aux broadcasts clients.
  const cd = guard.canClientBroadcast();
  if (!cd.allowed) {
    return res.status(429).json({
      error: 'Broadcast client en cooldown',
      retryAfterSec: cd.retryAfterSec,
    });
  }

  try {
    const result = await notifier.notifyClients(type);
    guard.recordClientBroadcast();
    res.json({ ok: true, recipientCount, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- CRUD clients ---
app.get('/api/clients', (req, res) => {
  res.json({ clients: db.listClients() });
});

app.post('/api/clients', (req, res) => {
  const { phone, name } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone requis' });
  try {
    const client = db.addClient(phone, name);
    res.status(201).json({ ok: true, client });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/clients/:phone', (req, res) => {
  const removed = db.removeClient(req.params.phone);
  if (!removed) return res.status(404).json({ error: 'Client introuvable' });
  res.json({ ok: true });
});

// --- Test : message avec boutons aux admins ---
app.post('/api/test', async (req, res) => {
  try {
    const results = await notifier.notifyAdminsText(
      `✅ Vigile Buyticle — message de test.\n\n${adminLinksBlock()}`,
      notifier.ADMIN_BUTTONS
    );
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function startup() {
  const problems = validate();
  if (problems.length) {
    console.warn('[startup] Configuration incomplète:', problems.join(' | '));
  }
  console.log(`[startup] Admins configurés: ${config.ADMIN_NUMBERS.map(notifier.maskPhone).join(', ') || '(aucun)'}`);
  console.log(`[startup] Stockage clients: ${db.filePath}`);

  const server = app.listen(config.PORT, () => {
    console.log(`[startup] Vigile Buyticle à l'écoute sur le port ${config.PORT}`);
  });

  // Message de démarrage aux admins ("Vigile actif") avec boutons.
  try {
    await notifier.notifyAdminsText(
      `🟢 Vigile actif — surveillance démarrée.\n\n${adminLinksBlock()}`,
      notifier.ADMIN_BUTTONS
    );
  } catch (e) {
    console.error('[startup] message démarrage échoué:', e.message);
  }

  // Démarre la boucle de monitoring.
  monitor.start();

  const shutdown = () => {
    console.log('[shutdown] arrêt...');
    monitor.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

startup();
