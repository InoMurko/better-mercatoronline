# Security audit trail

This is a log of security audits of this repository, run with
[cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill), **newest first**.

Each entry records when the audit ran, which commit it checked, which version of the skill it used, what it found and
which commits fixed what. The machine-readable output of each run (`findings.json`, `coverage-ledger.json`,
`run-metadata.json`, reports) is in [`security-audits/`](security-audits/). Audits build on each other: the skill reads
the previous runs' ledgers and starts with whatever they left open.

**How an audit runs here:**
- **Scope:** full audit mode on a snapshot of *committed files only*, so no `.env`, session, orders or history are
  included.
- **Evidence:** source review only. No audit agent runs the code or contacts the shop, Telegram or Anthropic.
- **Owner checks:** where a lead needs running to settle, the owner times it on their own machine with made-up input.
  Those results are recorded separately as *owner-observed*.

**To add an entry:**
- Put the new run on top.
- Keep the same headings.
- Commit its output under `security-audits/<date>-run-<n>/`.

---

## 2026-10-26 – run-2 · full audit (standard profile) · partial coverage

| | |
|---|---|
| **Ran** | 2026-10-26, 15:27–16:10 CET |
| **Commit audited** | `3f15c34` – Recipes: AI-first, drop the non-AI parser and fallbacks |
| **Skill version** | cloudflare/security-audit-skill @ `c1c8a8c` (2026-09-14) |
| **Agents** | 25 of a 25 budget: 4 reconnaissance, 10 hunters across 4 waves, 3 candidate verifiers, 5 coverage critics, 3 final record verifiers |
| **Result** | No confirmed vulnerabilities. 3 leads, all availability or log-integrity issues in handling stranger recipe pages. All 3 confirmed by the owner and fixed. |
| **Coverage** | 22 units covered, 2 holding the leads, **5 deferred** (budget ran out; listed below). The final coverage critic did not come back clean, so this run does **not** claim complete coverage. |
| **Details** | [`security-audits/2026-10-26-run-2/REPORT.md`](security-audits/2026-10-26-run-2/REPORT.md) |

### Found

| Lead (audit verdict: *needs validation*) | Where | Owner-observed | Fixed in |
|---|---|---|---|
| Deeply nested hidden or ingredient elements in a recipe page make parsing quadratic | `src/app/recipe.ts` `extractRecipe` | Depth 8k took 0.8 s / 97 MB, growing ~4× per doubling; a 2 MB page could crash the bot. Also found: linkedom's own parser slows sharply with depth (80k took 4.4 s). | `3321540` |
| The suspicious-text regex `<tool…[^>]*>` backtracks quadratically over hidden page text | `src/app/recipe.ts` `findSuspicious` | 144 ms at 8k repeats, ~2.5 s at the 200 KB cap | `3321540` |
| A recipe site's `Content-Type` / `Content-Encoding` header is copied raw into error messages printed to the console | `src/core/safe-fetch.ts` | Node accepted bytes 0x9B/0x9D; the message contained U+009B (a terminal control character) | `3321540` |

### Fixed – commit `3321540`

- **`findSuspicious`:** the regex no longer has the `[^>]*` tail. 200 KB of hostile text now takes 1–3 ms.
- **`extractRecipe`:**
  - Hidden-element text is collected with an early stop at 200k characters.
  - At most 20 ingredient-list candidates are considered, and each is measured once.
- **Deep pages:** a single linear pre-scan (`nestingDepth`) refuses pages nested more than 5,000 levels. The 2 MB attack
  page is refused in about 20 ms; real recipe pages are about 30 levels deep.
- **`safe-fetch`:** header values in error messages are reduced to printable ASCII and capped at 60 characters.
- **Tests:** a regression test for each fix. 67 tests pass.

### Hardening applied after the audit – commits `db4ae65`, `c22d8bd`, `495d59d`

These were the audit's hardening notes. None of them is a confirmed vulnerability. Each change has a test (80 pass).
Code was also changed for all 5 deferred areas, but those areas have still **not been audited**: the next run should
verify these changes rather than assume them.

- **Telegram bot:**
  - The owner check now requires your *private* chat **and** you as the sender; a group id never works.
  - `/start` setup works only in private chats.
  - Ignored chats are logged at most once an hour each, and container logs rotate (10 MB × 3). *(deferred #4, #5)*
  - Every basket change gets a new basket id, so buttons on an older basket message can't change the wrong line.
  - Pending buttons expire at lookup (24 h). The "to basket" and "straight to cart" pair cancel each other.
  - Basket lines are capped at 50, and cart quantities must be more than 0 and at most 99.
  - The recipe view fits within Telegram's message limit, and send errors are reported.
  - The daily check re-arms before it runs.
- **Checkout:** `confirmOrder` also compares the product lines, the product value and the delivery fee. It requires a
  delivery time and a pay-on-delivery payment of the configured kind (cash or card).
- **Shop client:**
  - Only Mercator hosts (`MERCATOR_EXTRA_HOSTS` adds more), no https→http redirects, and an exact login host check.
  - 30 s per hop and a 10 MB body cap.
  - The limiter never exceeds its maximum, and cart-lock waiters give up after 15 min.
  - Bounded listing cache *(deferred #1)*.
  - Data files are set to 600 and `orders/` to 700, and existing files are fixed on start *(deferred #3)*.
- **Recipes:**
  - `safe-fetch` closes refused sockets and aborts everything when it finishes.
  - Bidi isolate characters are stripped.
  - Lines for the same product merge, still capped at 6 packs.
  - `RECIPES_PER_DAY` is validated and kept across restarts.
  - CLI `--yes` no longer confirms `recipe --add`.
- **Replacement choice (AI):** catalogue data is fenced, one line per product, and the answer is checked with zod.
- **Logs:**
  - All console output is stripped of control characters.
  - The bot token, shop password and API key are redacted everywhere, including nested error causes *(deferred #2)*.
- **Docker:**
  - `MERC_UID`/`MERC_GID` must be numbers and never 0, and the app never runs with group 0.
  - A root-owned `/data` is only taken over while it is empty.
  - `cap_drop: ALL` + `CHOWN`/`SETUID`/`SETGID`, tested: the app ends with no capabilities.
  - A literal `FROM`, and the Node security floor for 22, 24 and 26.
- **CI:**
  - Actions pinned to commit SHAs.
  - Runs on every branch.
  - Fails if a personal data file is committed.
- **Commit check:** the pre-commit hook uses `-z`, so non-ASCII personal file names are caught.

### Still open

- **Deferred units 1–5:** code changed (see above) but not yet audited. The next run starts here.
- **Base image digest:** not pinned, because Docker Hub couldn't be reached from the audit environment. To pin it,
  run `docker buildx imagetools inspect node:22.23.4-slim` and append `@sha256:…` to the `FROM` line.
- **NAT64 prefixes:** network-specific prefixes are not recognised by the recipe SSRF guard. This only matters on an
  IPv6-only/DNS64 network; the default Docker network has no IPv6.
- **Parsing time:** recipe parsing has no wall-clock limit of its own. It is bounded by the 2 MB page, the 5,000-level
  nesting limit and the text caps.
- **Kept on purpose:**
  - HTML entities are still decoded with one small linkedom parse per line. It's bounded, and it keeps named
    entities working.
  - The `MERCATOR_MULTI_ADD` fallback can re-add after an ambiguous partial success. It's opt-in and still marked
    unverified.

### Previous leads

`recipe-cleanline-script-strip-regex-quadratic` from run-1 is resolved. It was fixed in `f99c4ba`, and this run
re-checked the current source.

---

## 2026-10-26 – run-1 · full audit attempted · incomplete

| | |
|---|---|
| **Ran** | 2026-10-26, about 13:00–13:15 CET |
| **Commit audited** | `600ca86` – Secret/personal-data pre-commit hook, CI and Dependabot |
| **Skill version** | cloudflare/security-audit-skill @ `c1c8a8c` (2026-09-14) |
| **Agents** | 0. The runner couldn't start sub-agents, so one reviewer did reconnaissance and review alone. No independent hunters, critics or verifiers ran. |
| **Result** | **Incomplete** by the skill's rules: no confirmed findings and 1 unvalidated lead. Its 14 coverage units were all re-done independently in run-2. |
| **Details** | [`security-audits/2026-10-26-run-1/`](security-audits/2026-10-26-run-1/) |

### Found

| Lead | Where | Owner-observed | Fixed in |
|---|---|---|---|
| The tag-stripping regex in `cleanLine` ran before the length cap, so one hostile JSON-LD ingredient took quadratic time | `src/app/recipe.ts` `cleanLine` | A 480k-character block took 2.9 s; about 4 such blocks fit in a 2 MB page (~12 s freeze) | `f99c4ba` |

### Fixed – commit `f99c4ba`

- **`cleanLine`:** caps its input before any parsing, and ingredient lists are capped before they are mapped. The
  480k-character block now takes 6 ms.
- **Crash fix:** a page without an `<html>` element no longer crashes the text fallback.
- **Hardening:**
  - `umask 077` in the bot and the CLI.
  - `no-new-privileges` in docker compose.
  - A corrected comment in the bot header.
