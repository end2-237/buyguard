'use strict';

// Fonction 1 — Monitoring serveur.
// Lecture de l'état HÔTE depuis le conteneur : nécessite network_mode host,
// montage de /proc et accès au socket Docker (voir README / docker-compose).
const { exec } = require('child_process');
const { config } = require('./config');
const notifier = require('./notifier');

// Types d'alerte considérés comme CRITIQUES (jamais mis en sourdine la nuit).
const CRITICAL_TYPES = new Set(['connection', 'cron']);

// Préfixes IP ignorés par défaut (en plus des plages privées et Meta/WhatsApp).
// 32.189. = agent Hostinger "monarx" (ex. 32.189.158.86).
const DEFAULT_ALLOWED_PREFIXES = ['32.189.'];

// Ports distants "standards" (HTTPS/HTTP) considérés légitimes : le C2 réel
// sortait sur un port haut (ex. 46572), pas sur 443/80.
const STANDARD_REMOTE_PORTS = new Set(['443', '80']);

// Libellés lisibles par type (pour les messages "résolu").
const TYPE_LABELS = {
  connection: 'Connexions sortantes suspectes',
  cpu_steal: 'CPU steal élevé',
  ram: 'RAM saturée',
  disk: 'Disque / presque plein',
  container: 'Conteneur critique arrêté',
  cron: 'Cron root suspect',
};

// État partagé exposé via /health et /api/status.
const lastState = {
  ts: null,
  cpuSteal: null,
  ramPct: null,
  diskPct: null,
  suspiciousConnections: [],
  stoppedCriticalContainers: [],
  suspiciousCron: null,
  errors: [],
};

// Cooldown par type d'alerte : { type: timestampMs du dernier envoi }.
const lastAlertAt = {};
// État "en cours" par condition (anti-répétition) : { type: {active, since, notified} }.
const conditions = {};

// Suivi d'un incident majeur persistant (pour l'auto-notice clients).
let incidentSince = null;
let autoClientNoticeSent = false;

function sh(cmd, timeoutMs = 8000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function inCooldown(type) {
  const last = lastAlertAt[type];
  if (!last) return false;
  return Date.now() - last < config.COOLDOWN_SEC * 1000;
}

// Machine à états d'une condition : UNE alerte au déclenchement, UNE "résolu"
// au retour à la normale, rien entre les deux (anti-répétition).
async function setCondition(type, triggered, buildAlert) {
  const cond = conditions[type] || (conditions[type] = { active: false, notified: false });
  const isCritical = CRITICAL_TYPES.has(type);

  if (triggered) {
    if (!cond.active) {
      cond.active = true;
      cond.since = Date.now();
      if (!inCooldown(type)) {
        lastAlertAt[type] = Date.now();
        console.log(`[monitor] ALERTE ${type}`);
        try {
          const res = await notifier.notifyAdmins(buildAlert(), { isCritical });
          cond.notified = !(res && (res.skipped || res.deferred));
        } catch (e) {
          console.error('[monitor] envoi alerte échoué:', e.message);
          cond.notified = false;
        }
      } else {
        cond.notified = false;
      }
    }
    // Déjà active : ne rien renvoyer.
  } else if (cond.active) {
    cond.active = false;
    if (cond.notified) {
      const label = TYPE_LABELS[type] || type;
      try {
        await notifier.notifyAdminsText(`✅ Résolu : ${label} — retour à la normale.`, undefined, {
          category: 'alert',
          isCritical: false,
          bypassDedup: true,
        });
      } catch (e) {
        console.error('[monitor] envoi résolution échoué:', e.message);
      }
    }
    cond.notified = false;
  }
}

// ---- Détection connexions sortantes suspectes (C2/botnet) ----

function isPrivateOrIgnored(ip) {
  if (!ip) return true;
  if (ip.includes(':')) return true; // IPv6 loopback/link-local : ignoré
  if (ip.startsWith('127.')) return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('169.254.')) return true;
  if (ip === '0.0.0.0') return true;
  if (ip.startsWith('172.')) {
    const second = Number(ip.split('.')[1]);
    if (second >= 16 && second <= 31) return true;
  }
  if (config.SERVER_PUBLIC_IP && ip === config.SERVER_PUBLIC_IP) return true;
  for (const pref of config.META_PREFIXES) if (ip.startsWith(pref)) return true;
  for (const pref of DEFAULT_ALLOWED_PREFIXES) if (ip.startsWith(pref)) return true;
  for (const pref of config.EXTRA_ALLOWED_PREFIXES) if (ip.startsWith(pref)) return true;
  return false;
}

function parseHostPort(field) {
  if (!field) return { ip: '', port: '' };
  const idx = field.lastIndexOf(':');
  if (idx === -1) return { ip: field, port: '' };
  let ip = field.slice(0, idx);
  const port = field.slice(idx + 1);
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  return { ip, port };
}

async function checkConnections() {
  const { stdout, err } = await sh('ss -tupnH state established 2>/dev/null');
  if (err && !stdout) {
    lastState.errors.push('ss indisponible');
    return;
  }
  const suspicious = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const cols = line.split(/\s+/);
    if (cols.length < 5) continue;
    const local = parseHostPort(cols[3]);
    const peer = parseHostPort(cols[4]);
    const proc = cols.slice(5).join(' ');

    if (local.port === '22' || peer.port === '22') continue; // SSH ignoré
    // Agent Hostinger monarx (HTTPS légitime) : jamais suspect.
    if (/monarx/i.test(proc)) continue;
    // Ports distants standards (HTTPS/HTTP) : trafic légitime (Meta, monarx…).
    if (STANDARD_REMOTE_PORTS.has(peer.port)) continue;

    if (!isPrivateOrIgnored(peer.ip)) {
      suspicious.push({
        remoteIp: peer.ip,
        remotePort: peer.port,
        localPort: local.port,
        process: proc,
      });
    }
  }
  lastState.suspiciousConnections = suspicious;

  await setCondition('connection', suspicious.length > 0, () => {
    const first = suspicious[0];
    return {
      title: 'Connexion sortante suspecte (C2/botnet ?)',
      value: `${suspicious.length} connexion(s) hors plages légitimes`,
      detail:
        `Ex: ${first.remoteIp}:${first.remotePort} ${first.process || ''}`.trim() +
        (suspicious.length > 1 ? ` (+${suspicious.length - 1} autres)` : ''),
      command: 'ss -tupn state established ; docker stop $(docker ps -q)',
    };
  });
}

// ---- CPU steal ----
async function checkCpuSteal() {
  let steal = null;
  const mp = await sh("mpstat 1 1 2>/dev/null | awk '/Average/ {print $NF}'");
  if (!mp.err && mp.stdout.trim()) {
    const v = Number(mp.stdout.trim().replace(',', '.'));
    if (Number.isFinite(v)) steal = v;
  }
  if (steal === null) {
    const top = await sh("top -bn1 2>/dev/null | grep -i '%Cpu'");
    const m = top.stdout.match(/([\d.,]+)\s*st/i);
    if (m) steal = Number(m[1].replace(',', '.'));
  }
  lastState.cpuSteal = steal;
  const triggered = steal !== null && steal > config.STEAL_MAX;
  await setCondition('cpu_steal', triggered, () => ({
    title: 'CPU steal élevé (voisin bruyant / VPS saturé)',
    value: `${steal}% (seuil ${config.STEAL_MAX}%)`,
    detail: 'Le CPU est volé par l\'hôte de virtualisation.',
    command: 'mpstat 1 5 ; top -bn1 | head -20',
  }));
}

// ---- RAM ----
async function checkRam() {
  const { stdout } = await sh("free -m 2>/dev/null | awk '/Mem:/ {print $2, $3}'");
  const parts = stdout.trim().split(/\s+/);
  let triggered = false;
  let pct = null;
  let used = null;
  let total = null;
  if (parts.length >= 2) {
    total = Number(parts[0]);
    used = Number(parts[1]);
    if (total > 0) {
      pct = Math.round((used / total) * 100);
      lastState.ramPct = pct;
      triggered = pct > config.RAM_MAX;
    }
  }
  await setCondition('ram', triggered, () => ({
    title: 'RAM saturée',
    value: `${pct}% (seuil ${config.RAM_MAX}%)`,
    detail: `${used} Mo / ${total} Mo utilisés`,
    command: 'free -m ; ps aux --sort=-%mem | head -10',
  }));
}

// ---- Disque / ----
async function checkDisk() {
  const { stdout } = await sh("df -P / 2>/dev/null | awk 'NR==2 {print $5}'");
  const m = stdout.trim().match(/(\d+)%/);
  let triggered = false;
  let pct = null;
  if (m) {
    pct = Number(m[1]);
    lastState.diskPct = pct;
    triggered = pct > config.DISK_MAX;
  }
  await setCondition('disk', triggered, () => ({
    title: 'Disque / presque plein',
    value: `${pct}% (seuil ${config.DISK_MAX}%)`,
    detail: 'Partition racine.',
    command: 'df -h ; du -xh / 2>/dev/null | sort -rh | head -20',
  }));
}

// ---- Conteneurs critiques arrêtés ----
async function checkContainers() {
  if (config.CRITICAL_CONTAINERS.length === 0) {
    lastState.stoppedCriticalContainers = [];
    await setCondition('container', false, () => ({}));
    return;
  }
  const { stdout, err } = await sh('docker ps --format "{{.Names}}" 2>/dev/null');
  if (err && !stdout) {
    lastState.errors.push('docker indisponible');
    return;
  }
  const running = new Set(
    stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  );
  const stopped = config.CRITICAL_CONTAINERS.filter((name) => !running.has(name));
  lastState.stoppedCriticalContainers = stopped;
  await setCondition('container', stopped.length > 0, () => ({
    title: 'Conteneur critique arrêté',
    value: stopped.join(', '),
    detail: 'Un ou plusieurs services critiques ne tournent pas.',
    command: `docker start ${stopped.join(' ')}`,
  }));
}

// ---- Cron root suspect ----
async function checkCron() {
  const { stdout } = await sh(
    'cat /var/spool/cron/crontabs/root /etc/crontab /etc/cron.d/* 2>/dev/null'
  );
  const suspiciousPatterns = /(pkill|nc\s|ncat|\/dev\/tcp|base64\s+-d|wget\s+http|curl\s+.*\|\s*sh)/i;
  const hit = stdout.split('\n').find((l) => {
    const line = l.trim();
    if (!line || line.startsWith('#')) return false;
    return suspiciousPatterns.test(line);
  });
  lastState.suspiciousCron = hit || null;
  await setCondition('cron', !!hit, () => ({
    title: 'Cron root suspect (ré-compromission ?)',
    value: 'Motif suspect détecté',
    detail: (hit || '').slice(0, 200),
    command: 'crontab -l -u root ; cat /etc/crontab /etc/cron.d/*',
  }));
}

function isMajorIncident() {
  return (
    lastState.stoppedCriticalContainers.length > 0 ||
    lastState.suspiciousConnections.length > 0 ||
    !!lastState.suspiciousCron
  );
}

async function maybeAutoClientNotice() {
  if (config.AUTO_CLIENT_NOTICE_MIN <= 0) return; // désactivé par défaut
  if (isMajorIncident()) {
    if (!incidentSince) incidentSince = Date.now();
    const elapsedMin = (Date.now() - incidentSince) / 60000;
    if (elapsedMin >= config.AUTO_CLIENT_NOTICE_MIN && !autoClientNoticeSent) {
      autoClientNoticeSent = true;
      console.log('[monitor] incident persistant -> notice AUTO clients (incident)');
      try {
        await notifier.notifyClients('incident');
      } catch (e) {
        console.error('[monitor] auto-notice clients échouée:', e.message);
      }
    }
  } else {
    incidentSince = null;
    autoClientNoticeSent = false;
  }
}

async function runChecks() {
  lastState.errors = [];
  await checkConnections();
  await checkCpuSteal();
  await checkRam();
  await checkDisk();
  await checkContainers();
  await checkCron();
  await maybeAutoClientNotice();
  // Fin des quiet hours : envoie le récapitulatif groupé s'il y en a un.
  try {
    await notifier.flushDeferred();
  } catch (e) {
    console.error('[monitor] flush récap échoué:', e.message);
  }
  lastState.ts = new Date().toISOString();
}

let timer = null;

function start() {
  const intervalMs = config.MONITOR_INTERVAL_SEC * 1000;
  console.log(`[monitor] démarrage, boucle toutes les ${config.MONITOR_INTERVAL_SEC}s`);
  runChecks().catch((e) => console.error('[monitor] erreur:', e.message));
  timer = setInterval(() => {
    runChecks().catch((e) => console.error('[monitor] erreur:', e.message));
  }, intervalMs);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, runChecks, lastState, isMajorIncident };
