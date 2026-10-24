import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relevantHistory, type HistoryEntry } from "../src/app/history.ts";
import { parseOrder } from "../src/app/order.ts";
import type { Product } from "../src/shop/products.ts";

const paper: Product[] = JSON.parse(readFileSync(new URL("./fixtures/toaletni-papir.json", import.meta.url), "utf8"));
const entry = (name: string, times: number, product: Product | null = null): HistoryEntry => ({
  name, purchases: [], timesOrdered: times, totalQuantity: times, lastPrice: 1, lastOrderFile: "x", product,
});
const yog = (name: string, cat = "NAVADNI JOGURTI"): Product => ({
  id: name, name, price: 1, unitPrice: 1, unitBase: "1kg", brand: null, category: `KISLO MLEKO, JOGURTI IN MLEČNI NAPITKI > ${cat}`, url: "",
});

test("order e-mail parses", () => {
  const o = parseOrder(readFileSync(new URL("./fixtures/order-example.txt", import.meta.url), "utf8"));
  assert.equal(o.length, 5);
  assert.deepEqual(o.find((l) => l.name.startsWith("Naravna mineralna voda")), {
    name: "Naravna mineralna voda, Donat, 100% reciklirana plastenka, 0,5 l", quantity: 6, unitPrice: 1.49,
  });
});

test("'toaletni papir' → the wet Hemo care you bought", () => {
  const hemo = paper.find((p) => p.name.startsWith("Vlažni toaletni papir Hemo"))!;
  const history = [entry("Skyr, Active Zone, 500 g", 3), entry(hemo.name, 2, hemo)];
  assert.equal(relevantHistory(history, "toaletni papir", paper)[0].name, hemo.name);
});

test("'jogurt' finds a Skyr through its category; 'mleko' does not", () => {
  const skyr = yog("Skyr, Active Zone, 500 g");
  const history = [entry(skyr.name, 3, skyr)];
  const jogurtResults = [yog("Navadni jogurt, 3,2 % m.m., 500 g"), yog("Grški jogurt, 10 % m.m., 500 g"), skyr];
  assert.equal(relevantHistory(history, "jogurt", jogurtResults)[0]?.name, skyr.name);
  const milkResults: Product[] = [{ ...yog("Trajno mleko, 3,5 % m.m., 1 l"), category: "MLEKO > TRAJNO MLEKO" }];
  assert.equal(relevantHistory(history, "mleko", milkResults).length, 0);
});

test("name match beats category match, then most ordered", () => {
  const a = yog("Grški jogurt, Olympus, 500 g");
  const b = yog("Skyr, Active Zone, 500 g");
  const history = [entry(b.name, 5, b), entry(a.name, 1, a)];
  assert.equal(relevantHistory(history, "grški jogurt", [a, b])[0].name, a.name);
});
