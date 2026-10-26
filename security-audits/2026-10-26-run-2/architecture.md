# Architecture summary – api-agent (snapshot 3f15c34)

## 1. Product, principals, protected resources
- **The product:** a personal, unofficial grocery agent for mercatoronline.si, run by one owner. It is TypeScript on Node ≥22.23.4, run with tsx and no build step.
  - It logs in to the shop's undocumented HTTP endpoints with the owner's credentials.
  - It learns buying habits from imported orders, builds a basket and fills the cart.
  - It can place pay-on-delivery orders (offlineCard/offlineCash only, `src/shop/checkout.ts:18-22`).
- **Owner:** drives it through the Telegram bot (`src/bot.ts`) or the CLI (`src/cli.ts`).
- **Principals:**
  - **Other Telegram chats:** dropped by middleware that compares `ctx.chat.id` with TELEGRAM_CHAT_ID (`src/bot.ts:91-105`). It checks the chat, not the sender. Before the id is set, `/start` echoes the chat id.
  - **Recipe page authors and their hosts** (strangers): control the HTML, JSON-LD, redirects and DNS answers of any link the owner submits.
  - **LLM output:** semi-trusted. A forced tool call, then zod validation, then shortlist id binding.
  - **Mercator responses:** semi-trusted. They supply form actions, hrefs and redirects that the client follows. Login posts credentials to the form action the shop page declares (`src/shop/auth.ts:22-28`).
  - **CLI operator:** the owner at a local shell.
- **Protected resources:**
  - shop credentials and the session cookie jar (`.env`, `.session.json`)
  - the Telegram token and the Anthropic key
  - the owner's cart and orders (real purchases)
  - personal data (`orders/`, `history.json`, `.basket.json`)
  - the host LAN and cloud metadata reachable from the process
  - host files behind the `/data` bind mount
  - the public repository and CI

## 2. Comparable baseline
No source-grounded comparable exists. `docs/mercator-api.md` documents the reverse-engineered endpoints.

## 3. Stack and deployment
- **Libraries:** grammy (long polling, no inbound server), linkedom, tough-cookie, zod, @anthropic-ai/sdk and dotenv.
- **Docker:**
  - Image is `node:22.23.4-slim`.
  - The entrypoint (`docker/entrypoint.sh`) starts as root, takes the owner of `/data` (or MERC_UID/MERC_GID), and drops privileges with setpriv. `*) exec "$@"` runs any other command.
  - Compose sets `env_file .env`, mounts `./data:/data`, and uses `no-new-privileges`.
- **CI:** `.github/workflows/ci.yml` has `contents: read` and `persist-credentials: false`. It runs `npm ci`, typecheck, tests, `npm audit` and the gitleaks action. Actions are pinned by tag.
- **Local secret check:** a pre-commit hook in `.githooks`, switched on through `prepare`.
- **No execution in this run:** the audit container has outbound network through a proxy and no OS-enforced per-process sandbox, so no target code runs and no scratch promotion is available.

## 4. Entry surfaces and paths
- **Telegram updates:** the gate at `bot.ts:91`.
  - Free text goes either to `startRecipe` (first `https?://` match) or to `pickFor` → shop search.
  - `/recipe <url>`.
  - Callbacks:
    - `rc:` (recipe toggles, servings, go) at `:402-443`
    - `co:` (checkout slot and go, pending map with 8-hex ids, 24 h expiry) at `:444-468`
    - `bk:` (basket inc/dec/del/go; no upper bound on quantity) at `:471-553`
    - `ok:`, `no:` and `like:` at `:571-609`
  - Daily job: import orders and send the due report.
- **Recipe link path:**
  1. `recipeFromUrl` (`src/app/recipe-match.ts`) checks the in-memory daily quota.
  2. `safeFetchHtml` (`src/core/safe-fetch.ts`):
     - scheme, port and userinfo checks; local-name regex
     - public-IP check inside the socket `lookup`, re-checked on every redirect, at most 3 redirects
     - 10 s, 2 MB after decompression, HTML only, `agent:false`, no cookies
  3. `extractRecipe` (`src/app/recipe.ts`): JSON-LD first, otherwise visible text with hidden elements removed. `cleanLine` caps and strips. `findSuspicious` warns.
  4. `parseIngredients` (`src/app/recipe-ai.ts`): fenced numbered lines, forced `report_ingredients` tool, strict zod schema.
  5. `matchRecipe`: shop `search` → `rankForIngredient` shortlist → `aiPick` (an id must be on that ingredient's shortlist) → `packsFor`, capped at 6.
  6. `renderRecipe` (`src/app/recipe-view.ts`, escaped HTML) → owner taps → `rc:go` adds to the basket → `bk:go` adds to the cart → `/checkout` → `co:go` → `confirmOrder`. `confirmOrder` re-reads the review and compares total, delivery time and payment, not the items.
- **Replacement choice:** `src/app/choose.ts`. The model answer is not zod-validated; the id must be on the shortlist. The reason string flows to the bot (escaped) and the CLI.
- **Shop HTTP:**
  - `src/core/http.ts` accepts absolute URLs (`abs()`) and follows redirects by hand to any host, keeping the method and body on 307/308.
  - It uses a tough-cookie jar. The session is saved with mode 600.
  - `ShopSession.anon` returns the same logged-in client.
  - Parsers: `src/shop/*` and `src/core/forms.ts`. `readForm` sends all hidden fields.
- **Files:**
  - `orders/<date>-<nr>.txt` (name made safe by `fileTag`), `history.json`, `.basket.json`, `.session.json`.
  - `families.json` is read only.
  - The bot and the CLI set umask 077.

## 5. Trust boundaries and strongest controls
- **Stranger page → LAN/metadata (SSRF):** the guarded socket lookup plus per-hop `checkUrl`.
- **Stranger page → availability:** fetch limits, then string caps in `cleanLine` and limits on JSON-LD count, size and depth. Parsing has no time bound.
- **Stranger page → LLM → owner's cart:** fence, single forced tool, schema, shortlist ids, pack cap, and three separate owner approvals.
- **Stranger text → Telegram HTML:** `esc()`.
- **Other Telegram chats → owner's authority:** the chat-id gate.
- **Shop pages → credentials and form data:** the form action host is not checked, and the success check is `hostname.endsWith("mercatoronline.si")`.
- **Container root → host:** setpriv privilege drop, uid 0 mapped to 1000.
- **Secrets and personal data → repo, image and logs:** .gitignore, .dockerignore, pre-commit hook, gitleaks.

## 6. Starting paths
`src/core/safe-fetch.ts`, `src/app/recipe*.ts`, `src/app/ai.ts`, `src/app/choose.ts`, `src/bot.ts`, `src/cli.ts`, `src/core/http.ts`, `src/core/forms.ts`, `src/shop/*.ts`, `src/app/basket*.ts`, `Dockerfile`, `docker/entrypoint.sh`, `docker-compose.yml`, `.github/`, `.githooks/`, `.gitignore`, `.dockerignore`.

## 7. Prior coverage (run-1, snapshot 600ca86)
- All 14 run-1 units were closed by one non-isolated parent reviewer with no independent agents, so every one of them is current work again.
- Changed source since run-1:
  - The recipe files went AI-only.
  - `cleanLine` now caps its input first.
  - JSON-LD ingredients are capped.
  - A page without `<html>` is now handled.
  - umask was added.
  - no-new-privileges was added.
- The run-1 lead `recipe-cleanline-script-strip-regex-quadratic` was later timed by the owner (2.9 s for a 480k-character block) and fixed in f99c4ba. Its unit is a changed-source revalidation target.
- No prior confirmed records exist, so there are no exclusions.
- New units from this reconnaissance:
  - credential and form steering through shop-supplied URLs
  - basket callback quantities
  - schema validation of the replacement-choice model output

## 8. Companion selection
| Companion file | Selected for |
|---|---|
| AI-AND-LLM | Page text sent to the model; model output that picks products; approval chain; substitute model |
| RESOURCE-EXHAUSTION-AND-AVAILABILITY | Untrusted HTML and JSON parsed on the single bot event loop; decompression |
| CLOUD-AND-DEPLOYMENT | SSRF to metadata and internal services; container root → host bind mount |
| SUPPLY-CHAIN-AND-RELEASE | CI workflow; lockfile and Docker build inputs |

Excluded:
- MEMORY-SAFETY: no native code.
- CLIENT-SIDE: nothing runs in a browser.
- DATA-ISOLATION: single tenant.
- DESKTOP/IPC: none.
- WEB-PROTOCOL-AND-AUTH: the target is an HTTP client, not a server with its own sessions. The credential-steering unit uses the ordinary chained-boundary block.
- PROTOCOLS-RPC: grammy long polling, no broker or webhook.
