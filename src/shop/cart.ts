/**
 * Cart: /shop_cart/shop_cart/* (docs/mercator-api.md §4). No pages, no clicks.
 * Cart writes run one at a time (the shop's session is one cart; parallel writes would only race).
 */
import { parseHTML } from "linkedom";
import { Http } from "../core/http.ts";
import { Mutex } from "../core/limiter.ts";
import type { Product } from "./products.ts";

const CONF = { cartConf: "default" };
const QUANTITY_LIMIT = "kosovne omejitve";
export const cartLock = new Mutex();

export type CartLine = {
  itemId: string;
  positionId: string;
  gtin: string | null;
  name: string;
  quantity: number;
  /** line total as the shop shows it (after discounts) */
  lineTotal: number | null;
  url: string | null;
};

const eur = (s: string | null | undefined) => {
  const m = (s ?? "").match(/([\d.]+,\d{2}|\d+(?:\.\d+)?)\s*EUR/);
  return m ? Number(m[1].replace(/\.(?=\d{3})/g, "").replace(",", ".")) : null;
};

/** The mini-cart HTML the shop returns with cart calls → lines. */
export function parseMiniCart(html: string): { count: number | null; lines: CartLine[] } {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  const lines = [...document.querySelectorAll("li.lib-cart[data-item-id]")].map((li) => {
    const nameEl = li.querySelector(".lib-cart-productName") ?? li.querySelector('a[href*="/izdelek/"][title]');
    return {
      itemId: li.getAttribute("data-item-id")!,
      positionId: li.getAttribute("data-position-id") ?? "",
      gtin: li.getAttribute("data-gtin"),
      name: (nameEl?.getAttribute("title") ?? nameEl?.textContent ?? "").replace(/\s+/g, " ").trim(),
      quantity: Number(li.getAttribute("data-quantity") ?? "0"),
      lineTotal: eur(li.querySelector(".product-price .price")?.textContent),
      url: nameEl?.getAttribute("href") ?? null,
    };
  });
  const count = document.querySelector(".lib-cart-items-count")?.textContent?.trim();
  return { count: count ? Number(count) : null, lines };
}

type CartJson = { success?: boolean; numItems?: number; minifiedShopCart?: string; error?: string; message?: string };

/** Lines in the cart (one request: checkCartStatus returns the mini-cart). */
export async function readCart(http: Http): Promise<CartLine[]> {
  const j = await http.json<CartJson>("/shop_cart/shop_cart/checkCartStatus", CONF);
  if (!j.success || typeof j.minifiedShopCart !== "string") throw new Error(`checkCartStatus: ${j.error || j.message || "unexpected answer"}`);
  return parseMiniCart(j.minifiedShopCart).lines;
}

export async function cartCount(http: Http): Promise<number> {
  const j = await http.json<CartJson>("/shop_cart/shop_cart/getCartInfo", CONF);
  if (!j.success) throw new Error(`getCartInfo: ${j.error || j.message || "failed"}`);
  return Number(j.numItems ?? 0);
}

export type AddResult = { ok: boolean; note?: string };

const errorText = (j: CartJson) => (j.error || j.message || "").replace(/<[^>]+>/g, "").trim();

/** Add one product (what the "DODAJ V KOŠARICO" button sends). */
export function add(http: Http, product: Pick<Product, "id" | "gtin">, quantity: number): Promise<AddResult> {
  return cartLock.lock(async () => {
    const j = await http.json<CartJson>("/shop_cart/shop_cart/ajaxAddToCart", {
      "products[0][id]": product.id,
      "products[0][quantity]": String(quantity),
      ...(product.gtin ? { "products[0][gtin]": product.gtin } : {}),
      analyticsListName: "Vsi izdelki",
      ...CONF,
    });
    if (!j.success) return { ok: false, note: errorText(j) || "the shop refused it" };
    if ((j.minifiedShopCart ?? "").includes(QUANTITY_LIMIT)) return { ok: false, note: "the shop limits how many of this product you can order" };
    return { ok: true };
  });
}

/**
 * Add many products. Uses ajaxAddMultiplePositionsToCart (one request) when MERCATOR_MULTI_ADD=1 – the site has it
 * but it isn't verified yet; otherwise (default) one verified add per product. Returns per-product results.
 */
export async function addMany(
  http: Http,
  items: { product: Pick<Product, "id" | "gtin" | "name">; qty: number }[],
  onProgress?: (done: number, total: number) => void,
): Promise<AddResult[]> {
  if (process.env.MERCATOR_MULTI_ADD === "1" && items.length > 1) {
    const before = await readCart(http).catch(() => null);
    const form: [string, string][] = [];
    items.forEach((it, i) => {
      form.push([`products[${i}][id]`, it.product.id], [`products[${i}][quantity]`, String(it.qty)]);
      if (it.product.gtin) form.push([`products[${i}][gtin]`, it.product.gtin]);
    });
    form.push(["analyticsListName", "Vsi izdelki"], ["cartConf", "default"]);
    const j = await cartLock.lock(() => http.json<CartJson>("/shop_cart/shop_cart/ajaxAddMultiplePositionsToCart", form)).catch(() => null);
    if (j?.success) {
      const after = await readCart(http);
      const had = new Map((before ?? []).map((l) => [l.itemId, l.quantity]));
      onProgress?.(items.length, items.length);
      return items.map((it) => {
        const now = after.find((l) => l.itemId === it.product.id)?.quantity ?? 0;
        return now >= (had.get(it.product.id) ?? 0) + it.qty - 1e-6 ? { ok: true } : { ok: false, note: `cart has ${now}` };
      });
    }
    // fall through to one-by-one
  }
  const out: AddResult[] = [];
  for (const [i, it] of items.entries()) {
    out.push(await add(http, it.product, it.qty).catch((e) => ({ ok: false, note: e instanceof Error ? e.message : String(e) })));
    onProgress?.(i + 1, items.length);
  }
  return out;
}

/** Set a cart line's quantity (0 removes it). Needs the line's positionId from readCart. 👁 not verified yet. */
export function setQuantity(http: Http, line: CartLine, quantity: number): Promise<AddResult> {
  return cartLock.lock(async () => {
    const path = quantity > 0 ? "/shop_cart/shop_cart/ajaxChangeQantity" : "/shop_cart/shop_cart/ajaxRemoveFromCart";
    const j = await http.json<CartJson>(path, {
      "products[0][id]": line.itemId,
      "products[0][quantity]": String(quantity > 0 ? quantity : line.quantity),
      ...(line.gtin ? { "products[0][gtin]": line.gtin } : {}),
      "products[0][cartPositionID]": line.positionId,
      ...CONF,
    });
    return j.success ? { ok: true } : { ok: false, note: errorText(j) || "the shop refused it" };
  });
}

/** Empty the cart (the site's own "izprazni košarico"). */
export function clearCart(http: Http): Promise<boolean> {
  return cartLock.lock(async () => {
    const j = await http.json<CartJson>("/shop_cart/shop_cart/resetCart", CONF);
    return !!j.success && (await cartCount(http)) === 0;
  });
}
