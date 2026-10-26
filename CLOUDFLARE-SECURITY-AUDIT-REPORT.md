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

### Still open

**Deferred units** (not reviewed; next run starts here):
1. In-memory state that grows over the bot's uptime: the product-listing cache, pending buttons, `LIST_PATHS`.
2. Secrets and personal data in runtime logs, including whether a network error could log the Telegram bot token.
3. Permissions of data files created before the `umask 077` change.
4. Sender identity inside the owner chat: the gate checks the chat, not the sender, which matters if
   `TELEGRAM_CHAT_ID` is a group.
5. Work and logging triggered by non-owner chats before the gate; container log rotation.

**Hardening notes** (not vulnerabilities; full list in the run report):
- **Telegram bot:**
  - Require a private chat or check `ctx.from.id` in the owner gate.
  - Revise the basket id on every change, so stale basket buttons can't change the wrong line.
  - Check the 24 h expiry of pending buttons when a button is tapped, not only when pruning.
  - `confirmOrder`: also compare the item lines, and require a non-empty delivery time and payment.
- **Shop client:**
  - Add a timeout and a body cap to `Http.follow`, and a deadline to `cartLock`.
  - Pin the login and redirect hosts to the shop and to https.
  - Use an exact host match for the login success check.
- **Model output:**
  - Validate the replacement-choice answer with zod.
  - Fence the shop data in its prompt.
- **Logs:** strip control characters from shop and model strings before logging.
- **CI and Docker:**
  - Pin Actions to commit SHAs and the base image to a digest.
  - Validate `MERC_UID`/`MERC_GID` as numbers.

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
