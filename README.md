# Vigile Buyticle

Mini-application Node.js (Express, 100% JavaScript) qui **surveille un VPS** et
**envoie des alertes WhatsApp**. Deux publics :

- **ADMIN** (propriétaire) : reçoit la **vérité technique complète**.
- **CLIENTS** : reçoivent uniquement des **messages rassurants** (maintenance /
  incident), sans aucun détail technique.

Déployable sur **Coolify** via `Dockerfile` / `docker-compose.yaml`. Stockage
clients dans un **volume persistant** (`/data/store.json`, pas de dépendance
native). Seule dépendance : `express`.

---

## Fonctionnalités

### 1. Monitoring serveur (boucle toutes les 30 s)

Déclenche une **alerte ADMIN** (WhatsApp détaillé) quand un seuil casse, avec un
**cooldown de 15 min par type** (`COOLDOWN_SEC`) :

| Contrôle | Déclencheur | Seuil |
|---|---|---|
| Connexion sortante suspecte (C2/botnet) | Connexion TCP établie vers une IP externe hors plages légitimes | — |
| CPU steal | `st` élevé (mpstat/top) | `STEAL_MAX` (40%) |
| RAM | % utilisé | `RAM_MAX` (92%) |
| Disque `/` | % utilisé | `DISK_MAX` (88%) |
| Conteneur critique arrêté | Absent de `docker ps` | `CRITICAL_CONTAINERS` |
| Cron root suspect | motif `pkill`, `/dev/tcp`, `curl … | sh`, etc. | — |

**Plages IGNORÉES** pour la détection C2 : loopback (`127.`), privées (`10.`,
`172.16-31.`, `192.168.`), link-local (`169.254.`), l'IP publique du serveur
(`SERVER_PUBLIC_IP`), le port **SSH 22**, et les plages **Meta/WhatsApp**
(`57.144.`, `31.13.`, `157.240.`, `179.60.`, `129.134.`). Ajoutez d'autres
préfixes de confiance via `EXTRA_ALLOWED_PREFIXES`.

Chaque alerte ADMIN indique : **quoi**, **valeur**, **IP/conteneur en cause**, et
une **commande d'urgence** (ex. `docker stop $(docker ps -q)`).

### 2. Messages clients (rassurance)

- Broadcast déclenché par l'admin : `POST /api/broadcast { "type": "incident" | "maintenance" | "retabli" }`.
- Messages pré-rédigés, calmes, sans technique.
- **Notice AUTO** (optionnelle) : si un incident majeur persiste plus de
  `AUTO_CLIENT_NOTICE_MIN` minutes (0 = désactivé), un message `incident` est
  envoyé automatiquement aux clients. L'admin garde la vérité complète en
  parallèle.

### 2 bis. Protection facturation (anti-rafale)

Toutes les sorties WhatsApp passent par un **gouverneur** (`src/guard.js`) qui
empêche toute rafale — donc toute explosion de facture — même si un incident
dure des heures ou si un bug boucle :

1. **Cooldown par type** (`COOLDOWN_SEC`, 15 min) : une même condition ne
   ré-alerte pas avant expiration.
2. **Anti-répétition (état « en cours »)** : **une** alerte au déclenchement,
   **une** alerte « ✅ Résolu » au retour à la normale, **rien** entre les deux.
3. **Plafond journalier** (`MAX_MSG_PER_DAY`, 30) : au-delà, l'app **arrête
   d'envoyer** pour la journée (log seulement). Compteur remis à zéro chaque jour.
4. **Coupe-circuit horaire** (`MAX_MSG_PER_HOUR`, 6) : si un envoi ferait
   dépasser le seuil, l'app **suspend les envois 1 h** et n'envoie qu'**un seul**
   message « Trop d'alertes, envois suspendus 1h — vérifie le serveur ».
5. **Broadcasts clients** : **jamais automatiques par défaut**
   (`AUTO_CLIENT_NOTICE_MIN=0`). Un broadcast part uniquement via
   `POST /api/broadcast` **avec `"confirm": true`** (l'appel sans confirmation
   renvoie le **nombre de destinataires** pour validation), et pas deux fois
   dans `CLIENT_BROADCAST_COOLDOWN` (1 h).
6. **Déduplication de contenu** : deux messages au texte identique dans la même
   fenêtre de cooldown ne partent pas deux fois.
7. **Quiet hours** (`QUIET_HOURS`, ex. `23-6`) : la nuit, les alertes **non
   critiques** sont **regroupées** en un seul récapitulatif envoyé à la fin de la
   plage. Le **botnet/connexions suspectes et le cron suspect restent
   prioritaires** et alertent immédiatement.
8. **Compteur visible** : `GET /api/status` expose `messaging` (messages envoyés
   aujourd'hui / cette heure, plafonds, état de suspension, quiet hours).

### 3. Gestion des numéros

- **ADMIN** : `ADMIN_NUMBERS` (séparés par virgule), reçoivent la vérité.
- **CLIENTS** : stockés en base, gérés via l'API protégée.
- Format international **sans `+`** (ex. `2376xxxxxxxx`).

---

## Endpoints

Tous les endpoints `/api/*` exigent le header **`x-admin-token: <ADMIN_API_TOKEN>`**.

| Méthode | Route | Description | Protégé |
|---|---|---|---|
| GET | `/health` | Statut app + derniers checks | non |
| GET | `/api/status` | Dernier état serveur (CPU, RAM, disque, connexions, conteneurs) | oui |
| POST | `/api/broadcast` | Broadcast clients `{ "type": "incident|maintenance|retabli" }` | oui |
| GET | `/api/clients` | Liste des clients | oui |
| POST | `/api/clients` | Ajoute `{ "phone": "2376xxxxxxxx", "name": "..." }` | oui |
| DELETE | `/api/clients/:phone` | Supprime un client | oui |
| POST | `/api/test` | Envoie un message de test (avec boutons) aux admins | oui |

Exemples :

```bash
# État serveur
curl -H "x-admin-token: $ADMIN_API_TOKEN" http://VPS:3000/api/status

# Ajouter un client
curl -X POST -H "x-admin-token: $ADMIN_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"phone":"237690000000","name":"Client A"}' http://VPS:3000/api/clients

# Broadcast incident — étape 1 : aperçu (renvoie recipientCount, n'envoie rien)
curl -X POST -H "x-admin-token: $ADMIN_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"incident"}' http://VPS:3000/api/broadcast
# Étape 2 : envoi confirmé
curl -X POST -H "x-admin-token: $ADMIN_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"incident","confirm":true}' http://VPS:3000/api/broadcast

# Message de test aux admins
curl -X POST -H "x-admin-token: $ADMIN_API_TOKEN" http://VPS:3000/api/test
```

---

## Envoi WhatsApp & fenêtre 24 h

Envoi via `POST https://graph.facebook.com/v26.0/{PHONE_NUMBER_ID}/messages`,
auth `Bearer {WHATSAPP_TOKEN}`.

- Messages **libres** (`text`, `interactive`/boutons pour l'admin) : **livrés
  seulement si le destinataire a écrit dans les dernières 24 h**.
- Pour des alertes/broadcasts **fiables hors fenêtre**, l'app tente d'abord le
  message libre ; en cas de refus Meta (fenêtre fermée), elle **retombe sur un
  TEMPLATE approuvé** si vous en configurez le nom :
  - `ADMIN_ALERT_TEMPLATE` (catégorie **UTILITY** recommandée)
  - `CLIENT_MSG_TEMPLATE` (**UTILITY** ou **MARKETING** selon le contenu)

### Créer les templates de secours

1. Meta Business Manager → **WhatsApp Manager → Modèles de message**.
2. Créez un modèle par public (ex. `vigile_admin_alert`, `vigile_client_notice`).
3. Langue = `fr` (ou ajustez `TEMPLATE_LANG`). Corps avec **un paramètre**
   `{{1}}` (l'app envoie un texte dans `{{1}}`).
4. Soumettez à approbation, puis renseignez les noms dans `ADMIN_ALERT_TEMPLATE`
   / `CLIENT_MSG_TEMPLATE`.

---

## Variables d'environnement

Voir `.env.example`. Principales :

| Variable | Rôle | Défaut |
|---|---|---|
| `WHATSAPP_TOKEN` | Token Meta (System User permanent conseillé) | — |
| `PHONE_NUMBER_ID` | ID du numéro WhatsApp | — |
| `ADMIN_NUMBERS` | Numéros admin (CSV, sans `+`) | — |
| `ADMIN_API_TOKEN` | Secret pour `/api/*` | — |
| `CRITICAL_CONTAINERS` | Conteneurs à surveiller (CSV) | vide |
| `STEAL_MAX` / `RAM_MAX` / `DISK_MAX` | Seuils % | 40 / 92 / 88 |
| `COOLDOWN_SEC` | Cooldown par type d'alerte | 900 |
| `MONITOR_INTERVAL_SEC` | Intervalle de la boucle | 30 |
| `SERVER_PUBLIC_IP` | IP publique du VPS (à ignorer) | vide |
| `EXTRA_ALLOWED_PREFIXES` | Préfixes IP de confiance (CSV) | vide |
| `ADMIN_ALERT_TEMPLATE` / `CLIENT_MSG_TEMPLATE` | Templates de secours | vide |
| `TEMPLATE_LANG` | Langue des templates | fr |
| `AUTO_CLIENT_NOTICE_MIN` | Délai auto-notice clients (0 = off) | 0 |
| `MAX_MSG_PER_DAY` | Plafond global journalier | 30 |
| `MAX_MSG_PER_HOUR` | Coupe-circuit horaire (suspension 1h au-delà) | 6 |
| `CLIENT_BROADCAST_COOLDOWN` | Délai min entre broadcasts clients (s) | 3600 |
| `QUIET_HOURS` | Heures calmes, ex. `23-6` (vide = off) | vide |
| `DATA_DIR` | Dossier persistant | /data |
| `PORT` | Port HTTP | 3000 |

---

## Comportement au démarrage

- Envoie un message de test **avec boutons** aux ADMIN (« Vigile actif »).
- Démarre la boucle de monitoring.
- Logs clairs sur **stdout** (pour Coolify). **Le token n'est jamais loggué.**

---

## Déploiement Coolify

L'app doit **observer l'hôte** depuis le conteneur. Dans Coolify, utilisez la
configuration avancée / **Docker Compose** (`docker-compose.yaml` fourni) qui
active :

- `network_mode: host` → `ss` voit les connexions réelles de l'hôte (pas de
  mapping `ports:` dans ce mode : l'app écoute directement sur `PORT` de l'hôte).
- `pid: host` + `/proc` → `top`, `free`, `mpstat` lisent l'état de l'hôte.
- `/var/run/docker.sock:ro` → `docker ps` / `docker start` des conteneurs hôte.
- Volume `vigile-data:/data` → persistance de la base clients.

### Étapes

1. Renseignez les variables (onglet **Environment** de Coolify) à partir de
   `.env.example`.
2. Déployez via le `docker-compose.yaml` (ou Dockerfile + montages équivalents
   dans la config avancée).
3. Vérifiez `GET /health`, puis `POST /api/test`.
4. Ajoutez vos clients via `POST /api/clients`.

> Sécurité : à déployer sur un **serveur propre** (après reset), avec un
> **token WhatsApp permanent**. Gardez `ADMIN_API_TOKEN` secret et long.

---

## Développement local

```bash
cp .env.example .env      # renseignez vos valeurs
npm install
DATA_DIR=./data npm start
```

Sur une machine de dev sans `ss`/`docker`/`mpstat`, les contrôles indisponibles
sont simplement ignorés (voir `errors` dans `/api/status`).

---

## Sécurité

- Le `WHATSAPP_TOKEN` **n'est jamais loggué**.
- Tous les endpoints `/api/*` sont protégés par `ADMIN_API_TOKEN`.
- Les numéros sont masqués dans les logs.
- Le socket Docker est monté en **lecture seule**.
