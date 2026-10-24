import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatOrder, parseOrder, readOrderText } from "../src/app/order.ts";

const pasted = readFileSync(new URL("./fixtures/order-example.txt", import.meta.url), "utf8");

test("header lines carry date and order number", () => {
  const rows = parseOrder(pasted);
  const f = readOrderText(formatOrder(rows, ["# date: 2024-03-02", "# order: 1234567"]));
  assert.equal(f.date, "2024-03-02");
  assert.equal(f.orderNo, "1234567");
  assert.equal(f.lines.length, 5);
});

test("stored format round-trips", () => {
  const rows = parseOrder(pasted);
  assert.deepEqual(parseOrder(formatOrder(rows, ["# subject", "# date"])), rows);
});
