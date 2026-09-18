'use strict';

// Fonction 1 — Monitoring serveur.
// Lecture de l'état HÔTE depuis le conteneur : nécessite network_mode host,
// montage de /proc et accès au socket Docker (voir README / docker-compose).
const { exec } = require('child_process');
const { config } = require('./config');
const notifier = require('./notifier');

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

// Suivi d'un incident majeur persistant (pour l'auto-notice clients).
let incidentSince = null; // timestamp ms du début d'un incident majeur
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

async function fireAlert(type, alert) {
  if (inCooldown(type)) return;
  lastAlertAt[type] = Date.now();
  console.log(`[monitor] ALERTE ${type}: ${alert.title} (${alert.value || ''})`);
  try {
    await notifier.notifyAdmins(alert);
  } catch (e) {
    console.error('[monitor] envoi alerte échoué:', e.message);
  }
}

// ---- Détection connexions sortantes suspectes (C2/botnet) ----

function isPrivateOrIgnored(ip) {
  if (!ip) return true;
  // IPv6 loopback / link-local : ignoré (on se concentre sur l'IPv4 sortante).
  if (ip.includes(':')) return true;
  if (ip.startsWith('127.')) return true; // loopback
  if (ip.startsWith('10.')) return true; // privé
  if (ip.startsWith('192.168.')) return true; // privé
  if (ip.startsWith('169.254.')) return true; // link-local
  if (ip === '0.0.0.0') return true;
  // 172.16.0.0 – 172.31.255.255
  if (ip.startsWith('172.')) {
    const second = Number(ip.split('.')[1]);
    if (second >= 16 && second <= 31) return true;
  }
  // IP publique du serveur lui-même
  if (config.SERVER_PUBLIC_IP && ip === config.SERVER_PUBLIC_IP) return true;
  // Plages Meta/WhatsApp
  for (const pref of config.META_PREFIXES) {
    if (ip.startsWith(pref)) return true;
  }
  // Préfixes additionnels autorisés
  for (const pref of config.EXTRA_ALLOWED_PREFIXES) {
    if (ip.startsWith(pref)) return true;
  }
  return false;
}

// Extrait "ip" et "port" d'un champ ss du type "1.2.3.4:443" ou "[::1]:22".
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
  // ss -tupnH state established : une connexion établie par ligne.
  const { stdout, err } = await sh('ss -tupnH state established 2>/dev/null');
  if (err && !stdout) {
    lastState.errors.push('ss indisponible');
    return;
  }
  const suspicious = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // Colonnes ss : Netid Recv-Q Send-Q Local Peer Process
    // Avec -H, pas d'en-tête. On récupère les 2 dernières adresses utiles.
    const cols = line.split(/\s+/);
    if (cols.length < 5) continue;
    // Local address = avant-dernière avant process ; format variable selon -t.
    // Pour "tcp 0 0 LOCAL PEER users:(...)" : cols[3]=local, cols[4]=peer.
    const localField = cols[3];
    const peerField = cols[4];
    const local = parseHostPort(localField);
    const peer = parseHostPort(peerField);

    // Ignore le SSH (port 22 local ou distant).
    if (local.port === '22' || peer.port === '22') continue;

    if (!isPrivateOrIgnored(peer.ip)) {
      const proc = cols.slice(5).join(' ');
      suspicious.push({
        remoteIp: peer.ip,
        remotePort: peer.port,
        localPort: local.port,
        process: proc,
      });
    }
  }
  lastState.suspiciousConnections = suspicious;

  if (suspicious.length > 0) {
    const first = suspicious[0];
    await fireAlert('connection', {
      title: 'Connexion sortante suspecte (C2/botnet ?)',
      value: `${suspicious.length} connexion(s) hors plages légitimes`,
      detail:
        `Ex: ${first.remoteIp}:${first.remotePort} ${first.process || ''}`.trim() +
        (suspicious.length > 1 ? ` (+${suspicious.length - 1} autres)` : ''),
      command: 'ss -tupn state established ; docker stop $(docker ps -q)',
    });
  }
}

// ---- CPU steal ----
async function checkCpuSteal() {
  // Essai mpstat, sinon top.
  let steal = null;
  const mp = await sh("mpstat 1 1 2>/dev/null | awk '/Average/ {print $NF}'");
  if (!mp.err && mp.stdout.trim()) {
    const v = Number(mp.stdout.trim().replace(',', '.'));
    if (Number.isFinite(v)) steal = v;
  }
  if (steal === null) {
    // top -bn1 : ligne "%Cpu(s): ... x st"
    const top = await sh("top -bn1 2>/dev/null | grep -i '%Cpu'");
    const m = top.stdout.match(/([\d.,]+)\s*st/i);
    if (m) steal = Number(m[1].replace(',', '.'));
  }
  lastState.cpuSteal = steal;
  if (steal !== null && steal > config.STEAL_MAX) {
    await fireAlert('cpu_steal', {
      title: 'CPU steal élevé (voisin bruyant / VPS saturé)',
      value: `${steal}% (seuil ${config.STEAL_MAX}%)`,
      detail: 'Le CPU est volé par l\'hôte de virtualisation.',
      command: 'mpstat 1 5 ; top -bn1 | head -20',
    });
  }
}

// ---- RAM ----
async function checkRam() {
  // free -m : total/used sur la ligne Mem.
  const { stdout } = await sh("free -m 2>/dev/null | awk '/Mem:/ {print $2, $3}'");
  const parts = stdout.trim().split(/\s+/);
  if (parts.length >= 2) {
    const total = Number(parts[0]);
    const used = Number(parts[1]);
    if (total > 0) {
      const pct = Math.round((used / total) * 100);
      lastState.ramPct = pct;
      if (pct > config.RAM_MAX) {
        await fireAlert('ram', {
          title: 'RAM saturée',
          value: `${pct}% (seuil ${config.RAM_MAX}%)`,
          detail: `${used} Mo / ${total} Mo utilisés`,
          command: 'free -m ; ps aux --sort=-%mem | head -10',
        });
      }
    }
  }
}

// ---- Disque / ----
async function checkDisk() {
  const { stdout } = await sh("df -P / 2>/dev/null | awk 'NR==2 {print $5}'");
  const m = stdout.trim().match(/(\d+)%/);
  if (m) {
    const pct = Number(m[1]);
    lastState.diskPct = pct;
    if (pct > config.DISK_MAX) {
      await fireAlert('disk', {
        title: 'Disque / presque plein',
        value: `${pct}% (seuil ${config.DISK_MAX}%)`,
        detail: 'Partition racine.',
        command: 'df -h ; du -xh / 2>/dev/null | sort -rh | head -20',
      });
    }
  }
}

// ---- Conteneurs critiques arrêtés ----
async function checkContainers() {
  if (config.CRITICAL_CONTAINERS.length === 0) {
    lastState.stoppedCriticalContainers = [];
    return;
  }
  // Liste des conteneurs en cours (noms).
  const { stdout, err } = await sh('docker ps --format "{{.Names}}" 2>/dev/null');
  if (err && !stdout) {
    lastState.errors.push('docker indisponible');
    return;
  }
  const running = new Set(
    stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  const stopped = config.CRITICAL_CONTAINERS.filter((name) => !running.has(name));
  lastState.stoppedCriticalContainers = stopped;
  if (stopped.length > 0) {
    await fireAlert('container', {
      title: 'Conteneur critique arrêté',
      value: stopped.join(', '),
      detail: 'Un ou plusieurs services critiques ne tournent pas.',
      command: `docker start ${stopped.join(' ')}`,
    });
  }
}

// ---- Cron root suspect ----
async function checkCron() {
  // Lit le crontab de root et les crons système.
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
  if (hit) {
    await fireAlert('cron', {
      title: 'Cron root suspect (ré-compromission ?)',
      value: 'Motif suspect détecté',
      detail: hit.slice(0, 200),
      command: 'crontab -l -u root ; cat /etc/crontab /etc/cron.d/*',
    });
  }
}

// Un "incident majeur" = conteneur critique arrêté OU connexion suspecte OU cron suspect.
function isMajorIncident() {
  return (
    lastState.stoppedCriticalContainers.length > 0 ||
    lastState.suspiciousConnections.length > 0 ||
    !!lastState.suspiciousCron
  );
}

async function maybeAutoClientNotice() {
  if (config.AUTO_CLIENT_NOTICE_MIN <= 0) return; // désactivé
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
    // Retour à la normale : reset (permet une future notice, pas d'auto "retabli").
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
  lastState.ts = new Date().toISOString();
}

let timer = null;

function start() {
  const intervalMs = config.MONITOR_INTERVAL_SEC * 1000;
  console.log(`[monitor] démarrage, boucle toutes les ${config.MONITOR_INTERVAL_SEC}s`);
  // Premier passage rapide puis intervalle régulier.
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
