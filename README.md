# Mercator API agent

A personal grocery agent for [Mercator Online](https://mercatoronline.si) (Slovenia) that learns your shopping habits
from your past orders, builds the basket you probably need, and lets you edit and order it from the terminal or Telegram.
It has **no browser**: it talks to the shop's own web endpoints (documented in [`docs/mercator-api.md`](docs/mercator-api.md))
over plain HTTP. No Chrome, no Stagehand, no AI needed to
read pages. Claude is only used, optionally, to double-check product replacements (see [Where AI is used](#where-ai-is-used-and-where-it-isnt)).

> **Unofficial.** Not affiliated with or endorsed by Mercator. It uses undocumented endpoints that can change at any time.
> Use it only with your own account, at human pace, and check Mercator's terms of business (Pogoji poslovanja).

```bash
cd api-agent
node -v                  # needs a patched Node: 22.23.4+, 24.22.1+ or 26.12.1+ (October 2026 security release)
npm install
cp .env.example .env      # MERCATOR_EMAIL, MERCATOR_PASSWORD (+ ANTHROPIC_API_KEY, Telegram – optional)
npm run cli -- login      # checks the login, saves the session (.session.json, mode 600)
npm run cli -- due
npm run bot
```

## Where AI is used (and where it isn't)
Almost nowhere – and it's optional.

**Not AI, plain code:** logging in, searching, prices and discounts, the cart, importing orders, learning your habits
(how often / how much you buy, what's running low), building the basket, matching "your" product, checkout and the
Telegram bot. These read the shop's own data, so they're exact, repeatable and free.

**AI, optionally – one job:** when a product you usually buy **isn't sold any more**, the code ranks possible
replacements (same type and variant, fat %, ply, brand tier, pack size, price per unit – see `src/app/similarity.ts`).
If `ANTHROPIC_API_KEY` is set, Claude then looks at the top candidates and confirms the best one, or says none fits.
Rules catch most cases, but some differences are about meaning rather than numbers (skyr vs Greek yoghurt, a kids'
version, a different flavour), and that's where a language model is better than a score.

- Called from `src/app/choose.ts` only: when building a basket (`/shop`, `cli shop`) or picking a product
  (`cli pick`, a product name in Telegram) – and only for discontinued products. Usually a handful of calls per basket.
- Sent: product names, prices, unit prices, brands, categories. Never your account, address, password or order history.
- Model: `ANTHROPIC_MODEL` (default `claude-haiku-5-5` – small and cheap); the answer comes back as a structured tool call.
- **Without the key** everything works the same; the top-ranked candidate is used without the double-check.
  `--no-llm` turns it off for a single CLI run.

## Commands (`npm run cli -- <command>`)
| Command | What it does |
|---|---|
| `login` | log in over HTTP (form → profil.mercator.si → back), save the session |
| `import [--max N]` | new orders from "Moja naročila" → `orders/` (order pages fetched in parallel) |
| `history` | look up every product you've bought → `history.json` (in parallel) |
| `due [--all] [--horizon N]` | what's running low |
| `shop [--add]` | the basket it thinks you need; `--add` puts it in the cart (asks) |
| `pick <search> [--like …] [--qty N] [--cheapest] [--add]` | your usual product / closest replacement |
| `cheapest <search> [--category …] [--by unit\|price] [--add]` | cheapest match |
| `cart [clear] [--yes]` | show / empty the cart |
| `checkout` | slot → pay on delivery → review → type `order` to place it (**experimental**, see below) |

The Telegram bot (`npm run bot`) has the same features as the browser version: /shop with an editable, paged basket,
/due, /cart, /clear, /import, /checkout, product names as messages, daily check.

## Docker
Runs the Telegram bot around the clock, without Node on your machine. Your data stays outside the image, in `./data`.

```bash
cp .env.example .env            # fill in MERCATOR_EMAIL, MERCATOR_PASSWORD, TELEGRAM_BOT_TOKEN …
mkdir -p data                   # create it yourself, so it's yours (the container runs as its owner)
docker compose build --pull

# first time: log in and import your orders (stored in ./data)
docker compose run --rm agent cli login
docker compose run --rm agent cli import

docker compose up -d            # start the bot (restarts automatically)
docker compose logs -f          # watch it
```

Already used the agent without Docker? Copy your data over instead of importing again:
`cp -r orders history.json .session.json data/`

| Task | Command |
|---|---|
| any CLI command | `docker compose run --rm agent cli <command>` – e.g. `cli due`, `cli pick "toaletni papir"` |
| interactive ones (they ask before acting) | `docker compose run --rm -it agent cli checkout` · `… cli cart clear` · `… cli shop --add` |
| first Telegram setup (get your chat id) | `docker compose up` (no `-d`), send `/start` to the bot, put `TELEGRAM_CHAT_ID` in `.env`, then `docker compose up -d` |
| update after `git pull` (also picks up new Node patch releases) | `docker compose build --pull && docker compose up -d` |
| stop | `docker compose down` |

Without compose:
```bash
docker build -t merc-agent .
docker run -d --name merc-agent --restart unless-stopped --env-file .env -v "$PWD/data:/data" merc-agent
docker run --rm -it --env-file .env -v "$PWD/data:/data" merc-agent cli due
```

Notes
- The image is pinned to Node ≥ 22.23.4 (October 2026 security release: eMudhra certificate distrust, Brotli and TLS fixes);
  the build stops if an older Node sneaks in. Bump `NODE_VERSION` in the `Dockerfile` for later patches, or build with
  `--build-arg NODE_VERSION=24.22.1` for Node 24 LTS.
- `.env` is passed in at run time and never copied into the image (`.dockerignore` keeps secrets and personal data out).
- The daily check runs at `DAILY_CHECK_AT` in the container's time zone: `TZ` (default `Europe/Ljubljana`).
- **File ownership:** the container starts as root only to see who owns `./data`, then runs everything as that user
  (via `setpriv`), so files stay yours on Linux too. If Docker created `./data` (owned by root), it's handed to uid 1000.
  Force a user with `MERC_UID`/`MERC_GID` in `.env`. Files inside `./data` owned by someone else (e.g. copied with
  `sudo`) are reported at start with the fix: `sudo chown -R $(id -u):$(id -g) data`.

## Concurrency
- All requests go through one client with a cap on parallel requests (`MERCATOR_CONCURRENCY`, default 4 – be polite).
- Parallel: search result pages, alternative queries, product lookups for the history, order-detail pages on import,
  planning a basket (one lookup per product), reading the cart while the basket is planned.
- One at a time on purpose: everything that changes the cart or the checkout (`cartLock`) – it's one cart per
  session, parallel writes would only race. GETs are retried with backoff on network errors / 5xx; POSTs never are.
- `MERCATOR_MULTI_ADD=1` tries the site's `ajaxAddMultiplePositionsToCart` (whole basket in one request) – not verified
  yet, so off by default; the verified one-request-per-product add is used otherwise.

## What's verified and what isn't
| Area | Status |
|---|---|
| search, prices, discounts, add to cart, cart count, reading the cart, order history | endpoints seen working (see `docs/mercator-api.md`) |
| login over HTTP | form and redirect chain known; **first real run is yours** (`npm run cli -- login`) |
| change quantity / remove one cart line | endpoints from the site's code, not called yet |
| checkout (slot, payment, confirm) | follows the site's own forms; **not recorded end-to-end yet** – it stops with an error on any surprise, and only places an order after it has read the review page and it matches what you approved |

Only pay-on-delivery is supported (`PAYMENT_METHOD=offlineCard|offlineCash`); the agent never pays online or sees card data.

## Layout
- `src/core/` – HTTP client (cookies, redirects, limiter, retries), HTML forms and text helpers
- `src/shop/` – one module per area of the shop: `auth`, `products`, `cart`, `orders`, `checkout`, `pages` (HTML parsers)
- `src/app/` – your logic: habits, similarity, offers, basket, history, restock, picking, replacements (`choose.ts`)
- `src/cli.ts`, `src/bot.ts` – entry points · `test/` – `npm test`

## Your data and secrets
Everything personal stays on your machine and is in `.gitignore`:

| File | Contains |
|---|---|
| `.env` | shop e-mail + password, Anthropic API key, Telegram bot token |
| `.session.json` | shop login cookies (written with mode 600) – treat like a password |
| `orders/`, `history.json` | your order history and products |
| `.basket.json`, `families.json`, `.agent-state.json` | your basket, product groupings, state |

Your password is only sent to Mercator's own login form. Product replacements sent to Claude contain product names
and prices only. The Telegram bot answers only the chat id in `TELEGRAM_CHAT_ID`.

Before publishing a fork: `git status --ignored` should list the files above as ignored, and `npm test` uses only
made-up fixtures (`test/fixtures/`).

## License
[MIT](LICENSE) © 2026 Ino Murko
