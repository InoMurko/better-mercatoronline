# Architecture summary – api-agent (snapshot 600ca86, commit 64d262c)

Reconnaissance was done inline by the parent. No Task/Agent tool was available, so the four baseline reconnaissance agents did not run.

## 1. Product, principals, protected resources
A personal grocery-shopping agent for mercatoronline.si, run by one owner (TypeScript, Node 22, tsx). It logs into the shop over plain HTTP with the owner's credentials, learns buying habits from past orders, fills the cart, and can place pay-on-delivery orders.
- **Owner**: drives everything through the Telegram bot (one chat id) or the CLI.
- **Other Telegram users**: can send messages to the bot. They are lower-trust.
- **Recipe page authors and their hosts**: strangers. They control the HTML, JSON-LD, redirects and DNS answers of any link the owner submits. They are lower-trust.
- **Mercator shop**: trusted data source and session issuer.
- **Anthropic API**: model provider, called with untrusted page text.
- **Protected resources**: shop credentials and session cookies (.env, .session.json); the Telegram token and API key; the owner's cart, orders and payment choice; personal data (orders/, history.json, .basket.json); the host's LAN and cloud metadata reachable from the container; files on the host behind the /data bind mount.

## 2. Comparable baseline
No source-grounded comparable exists.

## 3. Stack and deployment
- Libraries: grammy (long polling), linkedom, tough-cookie, zod, @anthropic-ai/sdk.
- Docker image node:22.23.4-slim. The entrypoint starts as root and drops to the owner of /data with setpriv. docker-compose bind-mounts ./data.
- CI runs typecheck, tests, npm audit and gitleaks.
- No offline execution in this run: the container is not a compliant sandbox.

## 4. Entry surfaces and paths
- **Telegram updates**: src/bot.ts:88 gate → commands and free text → recipe, search, basket and checkout callbacks.
- **Recipe link** (bot.ts:358-391, cli.ts:118):
  1. `recipeFromUrl` (recipe-match.ts:230)
  2. `safeFetchHtml` (safe-fetch.ts:221)
  3. `extractRecipe` (recipe.ts:173), which runs JSON-LD `structured` or `visibleText`, then `cleanLine`
  4. `parseIngredients` LLM (recipe-ai.ts:312), checked by a zod schema
  5. shop `search` (products.ts:73), then an optional `aiPick`
  6. `renderRecipe` (recipe-view.ts), then owner taps → basket → `bk:go` → cart → checkout
- **Shop responses** (trusted): cart, checkout and order parsers, and order files written to orders/.
- **Environment and CLI arguments** (operator).

## 5. Trust boundaries and strongest controls
- **Stranger page vs LAN/metadata**: public-only IP check inside the socket lookup, per-hop re-check, ports 80/443, no cookies.
- **Stranger page vs bot availability**: 10 s fetch timeout and 2 MB decompressed cap. Parsing is not time-bounded.
- **Stranger page vs LLM and cart**: forced single tool, strict schema, original text taken by line index, and owner approval at three separate steps.
- **Stranger text vs Telegram HTML**: `esc()` on every untrusted string.
- **Other Telegram users vs owner**: chat-id gate before every handler.
- **Container root vs host**: setpriv drop. Uid 0 is mapped to 1000.
- **Secrets and personal data vs repository and image**: .gitignore, .dockerignore, pre-commit hook, gitleaks in CI.

## 6. Starting paths
src/core/safe-fetch.ts, src/app/recipe*.ts, src/bot.ts, src/core/http.ts, src/shop/*.ts, Dockerfile, docker/entrypoint.sh, .github/.

## 7. Prior coverage
None. This is the first run, and no prior ledger exists.

## 8. Companion selection
| Companion file | Selected for |
|---|---|
| AI-AND-LLM | Page text sent to the model; model output that drives products shown for approval |
| RESOURCE-EXHAUSTION | Untrusted page parsed on the single bot event loop |
| CLOUD-AND-DEPLOYMENT | SSRF to metadata/internal services; container root → host |
| SUPPLY-CHAIN | CI workflow and the locked dependency build |

Excluded:
- Memory-safety: no native code.
- Client-side: nothing is executed in a browser.
- Data-isolation: single user.
- Desktop/IPC: no local IPC or desktop surfaces.
- Web-auth server: the target is a client, not a server.
- Protocols: no custom broker or webhook.
