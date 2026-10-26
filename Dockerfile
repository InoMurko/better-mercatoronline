# Mercator API agent – Telegram bot + CLI. No browser needed.
#   docker build --pull -t merc-agent .
#   docker run -d --name merc-agent --env-file .env -v "$PWD/data:/data" --restart unless-stopped \
#     --security-opt no-new-privileges:true --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID merc-agent
# Node 22.23.4 (21 Oct 2026) is the first 22.x with the October 2026 security release: it distrusts the eight
# compromised eMudhra intermediates / three emSign roots (Node uses its own bundled CA list, not the OS one)
# and fixes the Brotli RCE (CVE-2026-111497) and TLS hostname bypass (CVE-2026-106069). Don't go below it.
# A literal tag so Dependabot can propose updates. To pin the exact image too, append its digest:
#   docker buildx imagetools inspect node:22.23.4-slim   →   FROM node:22.23.4-slim@sha256:<digest>
FROM node:26.12.1-slim

ENV NODE_ENV=production \
    TZ=Europe/Ljubljana

WORKDIR /app
COPY package.json package-lock.json ./
# the October 2026 security release per line: 22.23.4, 24.22.1, 26.12.1 (same as "engines" in package.json)
RUN node -e "const [a,b,c]=process.versions.node.split('.').map(Number); const at=(x,y,z)=>b>y||(b===y&&c>=z); const ok=(a===22&&at(22,23,4))||(a===24&&at(24,22,1))||(a===26&&at(26,12,1))||a>26; if (!ok) { console.error('Node ' + process.versions.node + ' lacks the Oct 2026 security fixes – use 22.23.4+, 24.22.1+ or 26.12.1+'); process.exit(1) }" \
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
