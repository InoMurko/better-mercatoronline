/**
 * Mercator's discounts, from the search data, and the final price of a basket line.
 *
 * - Straight and Pika-card discounts are already in the product's price (current_price).
 * - Quantity offers only apply at a quantity: "Ob nakupu 2 izdelkov ali več je vsak 50%"
 *   (buy 2+, each 50 % off) is applied here; "1+1" (one free per one bought) gives you extra
 *   pieces for the same money; coupon offers need a coupon and are only shown.
 * The cart page stays the final word – after "Put in cart" the bot shows Mercator's own totals.
 */

export type Offer =
  | { kind: "multi"; minQty: number; percent: number; label: string; coupon?: string }
  | { kind: "free"; buy: number; get: number; label: string; coupon?: string }
  | { kind: "info"; label: string; pika?: boolean; coupon?: string };

/** Raw discount as the search endpoint returns it. */
export type RawDiscount = { group_type?: string; value?: string; marker_code?: string; hover_text?: string; coupon?: string };

export function parseOffers(raw: RawDiscount[] | undefined): Offer[] {
  const out: Offer[] = [];
  for (const d of raw ?? []) {
    const hover = (d.hover_text ?? "").trim();
    const coupon = d.coupon?.trim() || undefined;
    const multi = hover.match(/nakupu\s+(\d+)\s+izdelk\w*\s+ali\s+več\s+je\s+vsak\s+(\d+(?:[.,]\d+)?)\s*%/i);
    const free = (d.value ?? "").match(/^(\d+)\s*\+\s*(\d+)$/);
    if (multi) {
      const [minQty, percent] = [Number(multi[1]), Number(multi[2].replace(",", "."))];
      out.push({ kind: "multi", minQty, percent, coupon, label: `buy ${minQty}+ → −${percent} % each` });
    } else if (free) {
      const [buy, get] = [Number(free[1]), Number(free[2])];
      out.push({ kind: "free", buy, get, coupon, label: `${buy}+${get} free` });
    } else if (d.group_type === "pika_discount" && d.value) {
      out.push({ kind: "info", pika: true, label: `Pika ${d.value.startsWith("-") ? `${d.value} %` : d.value}` });
    } else if (/^-\d+$/.test(d.value ?? "")) {
      out.push({ kind: "info", label: `${d.value} %` });
    }
  }
  return out;
}

export type PricedLine = {
  /** what you pay for this line, with quantity offers applied */
  final: number;
  /** what it would cost at the regular price */
  regular: number;
  /** pieces you actually get (more than ordered with 1+1) */
  pieces: number;
  notes: string[];
};

export function priceLine(
  p: { price: number; regularPrice?: number | null; offers?: Offer[] },
  qty: number,
  { useCoupons = false } = {},
): PricedLine {
  let final = qty * p.price;
  let pieces = qty;
  const notes: string[] = [];
  for (const o of p.offers ?? []) {
    const usable = !o.coupon || useCoupons;
    if (o.kind === "multi") {
      if (qty >= o.minQty && usable) {
        final *= 1 - o.percent / 100;
        notes.push(`−${o.percent} % each (buying ${o.minQty}+)`);
      } else notes.push(`buy ${o.minQty}+ → −${o.percent} % each${o.coupon ? " (with coupon)" : ""}`);
    } else if (o.kind === "free") {
      if (usable) {
        pieces = qty + Math.floor(qty / o.buy) * o.get;
        notes.push(`${o.label}: you get ${pieces}`);
      } else notes.push(`${o.label} with coupon`);
    } else notes.push(o.label);
  }
  const regular = qty * Math.max(p.regularPrice ?? 0, p.price);
  return { final: Math.round(final * 100) / 100, regular: Math.round(regular * 100) / 100, pieces, notes };
}
