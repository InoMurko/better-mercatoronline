import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseOrderDetails, parseOrderList } from "../src/shop/pages.ts";
import { lineAddsUp } from "../src/shop/orders.ts";

// made-up pages in the exact shape of the real ones (see the comments in the fixtures)
const read = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");

test("order list", () => {
  const orders = parseOrderList(read("order-list.html"))!;
  assert.deepEqual(orders.map((o) => [o.orderNo, o.date, o.status, o.paid, o.detailsUrl]), [
    ["1000002", "2026-09-16", "Potrjeno", 74.5, "/uporabnik/podrobnosti-narocila/1000002"],
    ["1000001", "2023-01-12", "Potrjeno", 90, "/uporabnik/podrobnosti-narocila/1000001"],
  ]);
});

test("order details: delivered quantities, weighed items, lines that weren't delivered", () => {
  const d = parseOrderDetails(read("order-details.html"))!;
  // every line adds up – including the one that wasn't delivered (the shop keeps its ordered total)
  for (const l of d.lines) assert.ok(lineAddsUp(l), JSON.stringify(l));
  assert.equal(lineAddsUp({ name: "Bio korenje, 1 kg", quantity: 1, ordered: 1, unitPrice: 1.99, lineTotal: 5 }), false);
  const peaches = d.lines.find((l) => /breskve/i.test(l.name))!;
  assert.deepEqual([peaches.ordered, peaches.quantity], [0.75, 0.78]);
  assert.equal(d.lines.find((l) => /Bajadera/.test(l.name))!.quantity, 0);
  assert.equal(d.productsValue, 9.42);
});

test("unrelated page → null", () => {
  assert.equal(parseOrderList("<html><body><p>hello</p></body></html>"), null);
  assert.equal(parseOrderDetails("<html><body><p>hello</p></body></html>"), null);
});
