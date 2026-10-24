import { test } from "node:test";
import assert from "node:assert/strict";
import { renderBasket } from "../src/app/basket-view.ts";
import type { Basket } from "../src/app/basket.ts";
import type { Product } from "../src/shop/products.ts";

const p = (i: number): Product => ({
  id: String(i), name: `Toaletni papir Exclusive Plus, tiskan in parfumiran, 3-slojni, Paloma, 10/1 – ${i}`, price: 5.79,
  regularPrice: 6.99, unitPrice: 0.58, unitBase: "kos", brand: "PALOMA", category: "X > Y", url: "",
  offers: [{ kind: "multi", minQty: 2, percent: 50, label: "buy 2+ → −50 % each" }],
});
const big: Basket = {
  id: "abcd1234",
  items: Array.from({ length: 46 }, (_, i) => ({ product: p(i), qty: 12, note: `replaces something – ${"a reason ".repeat(20)}`, why: "runs out in ~3 days – added now so you don't need another delivery soon" })),
};

function check(b: Basket) {
  const pages = Math.ceil(b.items.length / 8) || 1;
  for (let page = 0; page < pages; page++) {
    const { text, kb } = renderBasket(b, page);
    const buttons = kb.inline_keyboard.flat();
    assert.ok(text.length <= 4096, `page ${page}: ${text.length} chars`);
    assert.ok(buttons.length <= 100, `page ${page}: ${buttons.length} buttons`);
    for (const btn of buttons) {
      const data = "callback_data" in btn ? btn.callback_data : "";
      assert.ok(Buffer.byteLength(data) <= 64, `callback data too long: ${data}`);
    }
  }
  return pages;
}

test("46-product basket fits Telegram's limits on every page", () => assert.equal(check(big), 6));
