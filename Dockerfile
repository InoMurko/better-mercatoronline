# Mercator API agent – Telegram bot + CLI. No browser needed.
#   docker build --pull -t merc-agent .
#   docker run -d --name merc-agent --env-file .env -v "$PWD/data:/data" --restart unless-stopped merc-agent
# Node 22.23.4 (21 Oct 2026) is the first 22.x with the October 2026 security release: it distrusts the eight
# compromised eMudhra intermediates / three emSign roots (Node uses its own bundled CA list, not the OS one)
# and fixes the Brotli RCE (CVE-2026-111497) and TLS hostname bypass (CVE-2026-106069). Don't go below it.
ARG NODE_VERSION=22.23.4
FROM node:${NODE_VERSION}-slim

ENV NODE_ENV=production \
    TZ=Europe/Ljubljana

WORKDIR /app
COPY package.json package-lock.json ./
RUN node -e "const [a,b,c]=process.versions.node.split('.').map(Number); if (a===22 && (b<23 || (b===23 && c<4))) { console.error('Node ' + process.versions.node + ' lacks the Oct 2026 security fixes – use >= 22.23.4'); process.exit(1) }" \
 && npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY docker/entrypoint.sh /usr/local/bin/merc
# files keep their host permissions when copied (often 600 = owner-only); the app runs as the "node" user,
# so make the code readable and the entrypoint executable for everyone (still owned by root – read-only for node)
RUN command -v setpriv >/dev/null \
 && chmod 755 /usr/local/bin/merc \
 && chmod -R a+rX /app \
 && mkdir -p /data && chown node:node /data

# your data (orders/, history.json, .session.json, .basket.json…) lives in /data – mount a volume there.
# The entrypoint starts as root only to see who owns /data, then drops to that user (setpriv) before anything runs.
WORKDIR /data
VOLUME /data

ENTRYPOINT ["merc"]
CMD ["bot"]
