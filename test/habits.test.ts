import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contentOf, groupFamilies, habits, packagesFor } from "../src/app/habits.ts";
import type { HistoryEntry } from "../src/app/history.ts";
import type { Product } from "../src/shop/products.ts";

const paper: Product[] = JSON.parse(readFileSync(new URL("./fixtures/toaletni-papir.json", import.meta.url), "utf8"));
const snap = (name: string) => paper.find((p) => p.name === name)!;
const entry = (name: string, purchases: [string, number][], product: Product | null = null): HistoryEntry => ({
  name,
  purchases: purchases.map(([date, quantity]) => ({ date, quantity, unitPrice: 1 })),
  timesOrdered: purchases.length,
  totalQuantity: purchases.reduce((s, [, q]) => s + q, 0),
  lastPrice: 1,
  lastOrderFile: "x",
  product,
});
const HEMO = "Vlažni toaletni papir Hemo care, Violeta, 60/1";
const OGNJIC = "Vlažni toaletni papir Ognjič, Violeta, 60 kosov";
const ROLLS = "Toaletni papir Premium, Violeta, 3-slojni, 10 rolic";
const ROLLS16 = "Toaletni papir, Violeta, 3-slojni, 16/1";

test("content per package", () => {
  assert.deepEqual(contentOf(HEMO), { amount: 60, unit: "kos" });
  assert.deepEqual(contentOf(ROLLS), { amount: 10, unit: "kos" });
  assert.deepEqual(contentOf("Naravna mineralna voda, Donat, 100% reciklirana plastenka, 0,5 l"), { amount: 500, unit: "ml" });
});

test("families: wet wipes together, rolls together, wet ≠ rolls", () => {
  const fams = groupFamilies(
    [entry(HEMO, [["2025-01-01", 1]], snap(HEMO)), entry(OGNJIC, [["2025-02-01", 1]], snap(OGNJIC)),
     entry(ROLLS, [["2025-01-05", 1]], snap(ROLLS)), entry(ROLLS16, [["2025-03-05", 1]], snap(ROLLS16))],
    new Map(),
  );
  const sets = fams.map((f) => f.members.map((m) => m.name).sort());
  assert.equal(fams.length, 2, JSON.stringify(sets));
  assert.ok(sets.some((s) => s.includes(HEMO) && s.includes(OGNJIC)));
  assert.ok(sets.some((s) => s.includes(ROLLS) && s.includes(ROLLS16)));
});

test("rolls every ~30 days → due when the last pack is used up; amount counted in rolls across pack sizes", () => {
  const h = habits(
    [entry(ROLLS, [["2025-06-01", 1], ["2025-07-01", 1], ["2025-07-31", 1]], snap(ROLLS)),
     entry(ROLLS16, [["2025-08-30", 1]], snap(ROLLS16))],  // switched to 16-roll packs: lasts ~48 days
    "2025-10-14", 7, new Map(),
  );
  assert.equal(h.length, 1);
  const [t] = h;
  assert.equal(t.unit, "kos");
  assert.ok(Math.abs(t.ratePerDay! - 10 / 30) < 0.02, `rate ${t.ratePerDay}`);
  assert.equal(t.usual.name, ROLLS16);
  // 16 rolls at ~1/3 per day → ~48 days → out around 2025-10-17; on 2025-10-14 that's within the 7-day horizon
  assert.equal(t.status, "due");
  assert.equal(packagesFor(t, ROLLS16), 1);
});

test("not due yet, dormant, too few", () => {
  const today = "2025-10-14";
  const [h] = habits([entry(HEMO, [["2025-08-01", 2], ["2025-09-01", 2], ["2025-10-01", 2]], snap(HEMO))], today, 7, new Map());
  assert.equal(h.status, "ok"); // bought 2 weeks ago, lasts ~a month
  const [d] = habits([entry(HEMO, [["2024-01-01", 2], ["2024-02-01", 2], ["2024-03-01", 2]], snap(HEMO))], today, 7, new Map());
  assert.equal(d.status, "dormant");
  const [f] = habits([entry(HEMO, [["2025-09-01", 2]], snap(HEMO))], today, 7, new Map());
  assert.equal(f.status, "too-few");
});

test("one long gap doesn't wreck the rate", () => {
  const [h] = habits(
    [entry(ROLLS, [["2025-01-01", 1], ["2025-01-31", 1], ["2025-05-01", 1], ["2025-05-31", 1], ["2025-06-30", 1]], snap(ROLLS))],
    "2025-07-10", 7, new Map(),
  );
  assert.ok(Math.abs(h.ratePerDay! - 10 / 30) < 0.02, `rate ${h.ratePerDay}`);
});
