import { test } from "node:test";
import assert from "node:assert/strict";
import { admit, shouldLog } from "../src/app/access.ts";
import { describeError, redact, safeText } from "../src/core/log.ts";

const OWNER = 111;
test("only the owner, in the private chat", () => {
  assert.equal(admit({ chat: { id: OWNER, type: "private" }, from: { id: OWNER } }, OWNER), "owner");
  assert.equal(admit({ chat: { id: OWNER, type: "private" } }, OWNER), "owner", "no sender (e.g. channel-less update) in the owner's private chat");
  assert.equal(admit({ chat: { id: -100, type: "group" }, from: { id: OWNER } }, -100), "ignore", "a group id configured as owner never works");
  assert.equal(admit({ chat: { id: OWNER, type: "private" }, from: { id: 222 } }, OWNER), "ignore", "someone else's sender in the owner chat");
  assert.equal(admit({ chat: { id: 222, type: "private" }, from: { id: 222 } }, OWNER), "ignore");
  assert.equal(admit({ chat: null, from: { id: OWNER } }, OWNER), "ignore");
});
test("setup mode answers /start only in private chats", () => {
  assert.equal(admit({ chat: { id: 5, type: "private" }, text: "/start" }, null), "setup");
  assert.equal(admit({ chat: { id: 5, type: "private" }, text: "/start@my_bot" }, null), "setup");
  assert.equal(admit({ chat: { id: -5, type: "group" }, text: "/start" }, null), "ignore");
  assert.equal(admit({ chat: { id: 5, type: "private" }, text: "/startx" }, null), "ignore");
});
test("ignored chats are logged at most hourly, memory bounded", () => {
  const seen = new Map<number, number>();
  assert.equal(shouldLog(seen, 1, 0), true);
  assert.equal(shouldLog(seen, 1, 1000), false);
  assert.equal(shouldLog(seen, 1, 3600_001), true);
  for (let i = 0; i < 1000; i++) shouldLog(seen, 1000 + i, 0);
  assert.ok(seen.size <= 200);
});
test("logs: secrets redacted, control characters stripped", () => {
  // token-shaped test values are built at runtime, so the secret scan doesn't flag this file
  const fakeToken = `123456789:${"A".repeat(35)}`;
  process.env.TELEGRAM_BOT_TOKEN = fakeToken;
  process.env.MERCATOR_PASSWORD = "hunter2-secret";
  const err = new Error(`request to https://api.telegram.org/bot${fakeToken}/getUpdates failed`, {
    cause: new Error("login with hunter2-secret \u001b[2J\u009b31m"),
  });
  const s = describeError(err, { stack: true });
  assert.ok(!s.includes("AAAAAAAA") && !s.includes("hunter2-secret"), s);
  assert.ok(!/[\u001b\u009b]/.test(s));
  assert.match(redact(`x bot987654321:${"B".repeat(35)} y`), /bot<TELEGRAM_BOT_TOKEN>/);
  assert.equal(safeText("a‮b\nc"), "ab\nc");
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.MERCATOR_PASSWORD;
});
