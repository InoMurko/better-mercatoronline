# Security audit report – run-2

**This was a partial pass.** Every candidate was independently validated and every record passed final verification. Coverage is still incomplete: the final-clean coverage critic found work that the budget could not fund, so **5 units are deferred** (listed below).

## 1. Run

| | |
|---|---|
| Skill | cloudflare/security-audit-skill @ `c1c8a8c` (2026-09-14) – full audit mode |
| Profile | standard |
| Scope | the whole `api-agent` repository |
| Source ref | `3f15c34` – a clean snapshot of committed files only (no `.env`, session, orders or history) |
| Date | 2026-10-26, 15:27–16:10 CET |
| Budget | 25 agent invocations. The owner agreed to "roughly 15–25". The parent set 24 and raised it to 25 to fund one Phase 5 verifier per record. **Spent: 25.** |
| Execution | Source-only. The audit platform has no OS-enforced sandbox and no promotion helper, so no target code ran, nothing was installed, and no external host was contacted. |
| Prior run | run-1 (`600ca86`). Its 14 units came from one non-isolated reviewer and were all re-done here. Its lead `recipe-cleanline-script-strip-regex-quadratic` is resolved: it was fixed in `f99c4ba`, and source was re-checked in this run. |

**Agents spent, 25 in total:**
- **Reconnaissance:** 4
- **Hunters:** 10, across 4 waves (6 + 1 + 2 + 1)
- **Candidate verifiers:** 3
- **Post-wave coverage critics:** 4
- **Final-clean critic:** 1
- **Phase 5 record verifiers:** 3

## 2. Posture

No confirmed vulnerability.

The boundaries that matter most held under independent review:
- **Stranger recipe page → home network / cloud metadata.** The SSRF guard checks the address inside the socket lookup and re-checks every redirect.
- **Stranger page → the model → cart.** Page text is fenced, there is one forced tool, a strict schema, shortlist-bound product ids, a pack cap, and three separate owner approvals.
- **Stranger text → Telegram HTML.** All of it is escaped.
- **Other Telegram chats → owner.** A chat-id gate stops them.
- **Container root → host.** The entrypoint drops privileges with setpriv.
- **Secrets → repository and image.** Kept out.

The leads were all **availability** issues in parsing stranger pages, plus one log-integrity issue.

## 3. Confirmed findings

None.

## 4. NEEDS VALIDATION

These are leads, with no severity assigned. Full records are in `NEEDS-VALIDATION.md`.

**Nested hidden or ingredient elements make `extractRecipe` do quadratic work**
- Trace: `bot.ts:367` → `safe-fetch.ts:222` → `recipe-match.ts:236` → `recipe.ts:178` (and `:151`)
- Blocker: no sandbox to run linkedom and `extractRecipe`
- Owner-observed: depth 8k took 814 ms and 97 MB, about 4× per doubling. linkedom's parser is also superlinear.
- Fix: `3321540`

**The `findSuspicious` `<tool…[^>]*>` regex backtracks quadratically**
- Trace: `bot.ts:388` → `recipe-match.ts:236` → `recipe.ts:178` → `:181` → `:67`
- Blocker: no sandbox to time V8's regex engine
- Owner-observed: 8k repeats took 144 ms, about 4× per doubling (≈2.5 s at the 200 KB cap).
- Fix: `3321540`

**A response header is copied raw into error text printed to the console**
- Trace: `bot.ts:388` → `recipe-match.ts:235` → `safe-fetch.ts:184` (and `:135`) → `bot.ts:83`
- Blockers: Node header parsing and terminal behaviour could not be observed
- Owner-observed: Node accepted bytes 0x9B/0x9D in the header, and the message contained U+009B (CSI).
- Fix: `3321540`

The owner-observed checks ran on the owner's own machine with synthetic input. They are outside the audit's evidence, which is why these records keep their `needs_validation` verdict.

## 5. Hardening notes (not findings)

**Telegram bot**
- The owner gate checks the chat, not the sender. If `TELEGRAM_CHAT_ID` were a group, every member would get full control. Fix: require a private chat or check `ctx.from.id`. *(A deferred unit covers this.)*
- The basket id is not revised when the basket changes, and buttons address lines by position. A stale basket message can therefore change a different line.
- The 24 h expiry of pending buttons is checked only when pruning, never when a button is looked up. One item also gets two sibling pending ids.
- `confirmOrder` compares total, delivery time and payment, but not the item lines. It also accepts an empty "when" or payment field on both reads.
- No upper bound on basket quantity or CLI `--qty`. A negative `--qty` is not rejected.
- The rendered recipe is sent without chunking, outside `work()`'s try/catch. An over-long recipe page fails silently.
- Error replies can go over Telegram's 4096-character limit.
- The daily check re-arms only after its job finishes, so one hung import stops all later checks.

**Shop client**
- `Http.follow` has no timeout and no body cap. A hung shop call holds a limiter slot and `cartLock` indefinitely. `Mutex.lock` has no deadline.
- The limiter can briefly exceed its maximum.
- The login POST and 307/308 hops are not pinned to the shop's hosts or to https.
- The login success check is suffix-only: `endsWith("mercatoronline.si")`.
- Shop-supplied hrefs can point to any host.
- `.session.json` gets mode 0600 only when the file is first created.

**Recipe pipeline**
- `safe-fetch` drains redirect, error and non-HTML bodies instead of closing the socket, and never aborts in `finally`.
- NAT64 prefixes specific to a network are not recognised.
- Parsing runs outside the 10 s fetch deadline.
- `cleanLine` misses the bidi isolate characters U+2066–2069 and U+061C.
- HTML is decoded with one linkedom parse per line.
- `MAX_PACKS` caps each line, not each product: two lines that map to one product can merge above 6.
- `RECIPES_PER_DAY` is held in memory, and a value that isn't a number disables it.
- CLI `--yes` also auto-confirms `recipe --add`.

**Replacement choice**
- The substitute prompt has no data fence. Shop names containing newlines could forge rows, although selection stays bound to the shortlist.
- The tool answer is cast instead of validated with zod.
- The reason text is printed raw to the CLI.
- Shop-supplied and model-supplied strings reach the terminal and logs with no control-character stripping.

**Deployment and CI**
- Pin GitHub Actions to commit SHAs.
- Pin the base image by digest, using a literal `FROM` so Dependabot can track it.
- Validate `MERC_UID`/`MERC_GID` as numbers: "00" or "root" causes a re-exec loop, and GID 0 is allowed.
- Prefer failing over chowning a root-owned `./data` folder to 1000.
- The `docker run` example lacks `no-new-privileges`.
- The pre-commit hook should use `-z` for non-ASCII paths, and CI has no check for personal-data paths.
- The Node-version floor check covers only major version 22.

**Positive patterns seen**
- **SSRF:** the address is checked at connect time, with a per-hop re-check.
- **Model output:** zod schemas, shortlist id binding, and the original page text kept by line number.
- **Taps:** one tap gives one action.
- **Repository:** lockfile integrity hashes, and CI with a read-only token.
- **Order files:** file names are sanitised.

## 6. Coverage

| Status | Units |
|---|---|
| covered | 22 |
| candidate (records above) | 2 |
| deferred | 5 |
| blocked | 0 |

Every critic ran: post-wave critics after waves 1–4, and the final-clean critic. The final-clean critic did **not** return clean, so this run makes no claim of complete coverage.

**Deferred** (budget: `budget_cannot_reserve_critics_and_validation`):
1. In-memory state that grows for as long as the bot runs: the listing cache, the pending map and `LIST_PATHS`.
2. Redaction of secrets and personal data in runtime logs, including whether a network error could log the Telegram bot token.
3. File modes on files created before the umask change, after an upgrade.
4. Sender identity inside the owner chat (group chat; business messages).
5. Work and logging before the owner gate for non-owner chats, and log volume with no rotation.

**Excluded companions:**
- MEMORY-SAFETY: no native code.
- CLIENT-SIDE: nothing runs in a browser.
- DATA-ISOLATION: single tenant.
- DESKTOP/IPC: none present.
- WEB-PROTOCOL-AND-AUTH: the target is an HTTP client, not a server.
- PROTOCOLS-RPC: selected only for deferred unit 4.

A next run should start with the 5 deferred units.
