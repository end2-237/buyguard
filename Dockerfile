FROM node:20-alpine

# Outils nécessaires pour observer l'HÔTE :
#  - iproute2 : commande `ss` (connexions établies)
#  - procps   : `top`, `free`
#  - sysstat  : `mpstat` (CPU steal)
#  - docker-cli: `docker ps/start` via le socket monté
#  - coreutils: `df`, `du` fiables
RUN apk add --no-cache iproute2 procps sysstat docker-cli coreutils

WORKDIR /app

# Installe uniquement les deps de prod (cache Docker sur package.json).
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

# Volume persistant pour la base clients / config.
ENV DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 3000

# Healthcheck simple sur /health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
