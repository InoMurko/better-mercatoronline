import { test } from "node:test";
import assert from "node:assert/strict";
import { addItem, changeQty, removeItem, total, type Basket } from "../src/app/basket.ts";
import type { Product } from "../src/shop/products.ts";

const p = (id: string, price: number): Product => ({ id, name: id, price, unitPrice: null, unitBase: null, brand: null, category: "", url: "" });
const b: Basket = { id: "x", items: [{ product: p("skyr", 1.69), qty: 1, note: "your usual" }, { product: p("donat", 1.49), qty: 24, note: "your usual" }] };

test("three yoghurts instead of one", () => {
  const b2 = changeQty(changeQty(b, 0, +1), 0, +1);
  assert.equal(b2.items[0].qty, 3);
  assert.equal(b.items[0].qty, 1, "original untouched");
});
test("minus at 1 removes the line; 🗑 removes it", () => {
  assert.deepEqual(changeQty(b, 0, -1).items.map((i) => i.product.id), ["donat"]);
  assert.deepEqual(removeItem(b, 1).items.map((i) => i.product.id), ["skyr"]);
});
test("adding something already in the basket raises its quantity", () => {
  const b2 = addItem(b, { product: p("skyr", 1.69), qty: 2, note: "your choice" });
  assert.equal(b2.items.length, 2);
  assert.equal(b2.items[0].qty, 3);
  assert.equal(addItem(b, { product: p("maslo", 4.19), qty: 1, note: "" }).items.length, 3);
});
test("total", () => assert.equal(total(b).toFixed(2), (1.69 + 24 * 1.49).toFixed(2)));

import { shortName } from "../src/app/basket.ts";
test("short names for phone buttons", () => {
  assert.equal(shortName("Naravna mineralna voda, Donat, 100% reciklirana plastenka, 0,5 l", "DONAT"), "Naravna mineralna voda, Donat, 0,5 l");
  assert.equal(shortName("Skyr, Active Zone, 500 g", "ACTIVE ZONE"), "Skyr, Active Zone, 500 g");
  assert.equal(shortName("Toaletni papir Exclusive Plus, tiskan in parfumiran, 3-slojni, Paloma, 10/1", "PALOMA EXCLUSIVE"), "Toaletni papir Exclusive Plus, 10/1");
  assert.equal(shortName("Trajno pol posneto mleko Lejko, 1,5 % m.m., Pomurske mlekarne, 1 l", "POMURSKE MLEKARNE"), "Trajno pol posneto mleko Lejko, 1,5 %");
  assert.equal(shortName("Pivo Bevog Tak pale ale, 5,5 % alkohola, 0,33 l", "BEVOG"), "Pivo Bevog Tak pale ale, 5,5 %, 0,33 l");
  assert.equal(shortName("Toaletni papir, Violeta, 3-slojni, 16/1", "VIOLETA"), "Toaletni papir, 3-slojni, 16/1"); // brand would make it 39
  assert.ok(shortName("Rumene breskve, cena za kg", null).length <= 38);
});

test("basket lines are capped at MAX_QTY", async () => {
  const { addItem, changeQty, MAX_QTY } = await import("../src/app/basket.ts");
  const p = { id: "1", name: "Jogurt", price: 1, unitPrice: null, unitBase: null, brand: null, category: "", url: "" };
  let b = addItem({ id: "x", items: [] }, { product: p, qty: 300, note: "" });
  assert.equal(b.items[0].qty, MAX_QTY);
  b = addItem(b, { product: p, qty: 5, note: "" });
  assert.equal(b.items[0].qty, MAX_QTY);
  assert.equal(changeQty(b, 0, +1), b, "no change above the cap");
  const { checkQuantity } = await import("../src/shop/cart.ts");
  assert.throws(() => checkQuantity(-3));
  assert.throws(() => checkQuantity(0));
  assert.throws(() => checkQuantity(1000));
  assert.doesNotThrow(() => checkQuantity(0.5));
});
