/**
 * A shopping basket you edit in Telegram before anything goes into the Mercator cart.
 * Plain data + pure functions (tested in test/basket.test.ts); kept in .basket.json across bot restarts.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { CartItem } from "./restock.ts";
import { priceLine } from "./offers.ts";

export const BASKET_FILE = ".basket.json";
export type Basket = { id: string; items: CartItem[] };

/** Final total, with quantity offers applied (see offers.ts). */
export const total = (b: Basket) => b.items.reduce((s, i) => s + priceLine(i.product, i.qty).final, 0);
/** What the same basket would cost at regular prices. */
export const regularTotal = (b: Basket) => b.items.reduce((s, i) => s + priceLine(i.product, i.qty).regular, 0);

/** Add a product, or raise its quantity when it's already in the basket. */
export function addItem(b: Basket, item: CartItem): Basket {
  const at = b.items.findIndex((i) => i.product.id === item.product.id);
  if (at < 0) return { ...b, items: [...b.items, item] };
  const items = [...b.items];
  items[at] = { ...items[at], qty: items[at].qty + item.qty };
  return { ...b, items };
}

/** +1 / -1 on one line; going below 1 removes the line. */
export function changeQty(b: Basket, index: number, delta: number): Basket {
  const item = b.items[index];
  if (!item) return b;
  const qty = item.qty + delta;
  if (qty < 1) return removeItem(b, index);
  const items = [...b.items];
  items[index] = { ...item, qty };
  return { ...b, items };
}

export const removeItem = (b: Basket, index: number): Basket => ({ ...b, items: b.items.filter((_, i) => i !== index) });

export function loadBasket(): Basket | null {
  try {
    return existsSync(BASKET_FILE) ? JSON.parse(readFileSync(BASKET_FILE, "utf8")) : null;
  } catch {
    return null;
  }
}
export function saveBasket(b: Basket | null) {
  writeFileSync(BASKET_FILE, JSON.stringify(b, null, 2) + "\n");
}

/**
 * A name short enough for a full-width button on a phone (~38 characters). Keeps, in order of importance:
 * what it is, fat/alcohol % (shortened to "1,5 %"), ply, size, brand – each only if it still fits –
 * in the order they appear in the full name. E.g. "Trajno pol posneto mleko Lejko, 1,5 %".
 */
export function shortName(name: string, brand?: string | null, max = 38): string {
  const segs = name.split(/,\s+/).map((s) => s.trim()).filter(Boolean);
  if (!segs.length) return name.slice(0, max);
  const brandWord = brand?.split(/\s+/)[0]?.toLowerCase();
  const rest = segs.slice(1).map((text, i) => ({ text, at: i + 1 }));
  const pick = (re: RegExp) => rest.filter((r) => re.test(r.text));
  const percent = pick(/^\d+(?:[.,]\d+)?\s*%(\s*(m\.?\s*m\.?|alkohola))?$/i).map((r) => ({ ...r, text: r.text.replace(/\s*(m\.?\s*m\.?|alkohola)$/i, "") }));
  const ply = pick(/\d\s*-?\s*slo(jn|nj)i/i);
  const size = pick(/\d\s*(ml|l|g|kg|kos|kosov|kosi|rolic)\b|\d+\s*\/\s*1\b|\d+\s*x\s*\d/i).slice(-1);
  const brandSeg = brandWord ? rest.filter((r) => r.text.toLowerCase().includes(brandWord)).slice(0, 1) : [];

  const chosen: { text: string; at: number }[] = [{ text: segs[0], at: 0 }];
  const len = () => chosen.map((c) => c.text).join(", ").length;
  for (const cand of [...percent, ...ply, ...size, ...brandSeg]) {
    if (chosen.some((c) => c.at === cand.at)) continue;
    chosen.push(cand);
    if (len() > max) chosen.pop();
  }
  const out = chosen.sort((a, b) => a.at - b.at).map((c) => c.text).join(", ");
  return out.length <= max ? out : `${out.slice(0, max - 1).trimEnd()}…`;
}
