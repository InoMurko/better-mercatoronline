/** Which product would you actually want for a search? Your usual one, else the closest replacement. */
import { Http } from "../core/http.ts";
import { chooseSubstitute } from "./choose.ts";
import { historyIsStale, loadHistory, rebuildHistory, relevantHistory } from "./history.ts";
import { findByName, findCheapest, search, type Product } from "../shop/products.ts";
import type { Reference } from "./similarity.ts";

export const fmtProduct = (p: Product) =>
  `${p.name} – ${p.price.toFixed(2)} €` + (p.unitPrice != null ? ` (${p.unitPrice.toFixed(2)} €/${p.unitBase})` : "");

export type PickPlan = { choice: Product | null; qty: number; lines: string[]; alsoBought: string[]; options: Product[] };

export async function planPick(
  http: Http,
  query: string,
  opts: { like?: string; qty?: number; cheapest?: boolean; useLlm?: boolean; historyLookups?: number } = {},
): Promise<PickPlan> {
  const lines: string[] = [];
  let history = loadHistory();
  if (historyIsStale()) history = await rebuildHistory(http, { maxLookups: opts.historyLookups });
  // search and (for --like) the exact lookup in parallel
  const [results, liked] = await Promise.all([
    query ? search(http, query, 300) : Promise.resolve([] as Product[]),
    opts.like ? findByName(http, opts.like) : Promise.resolve(null),
  ]);

  let ref: Reference | null = null;
  let usualQty = 1;
  let alsoBought: string[] = [];
  if (opts.like) {
    const past = history.find((e) => e.name === opts.like);
    ref = liked?.product ?? past?.product ?? { name: opts.like, price: past?.lastPrice ?? NaN };
    lines.push(`Like: ${opts.like}`);
  } else {
    const relevant = relevantHistory(history, query, results);
    if (relevant.length) {
      const usual = relevant[0];
      ref = usual.product ?? { name: usual.name, price: usual.lastPrice };
      usualQty = Math.max(1, Math.round(usual.totalQuantity / usual.timesOrdered));
      lines.push(`You usually buy: ${usual.name} (ordered ${usual.timesOrdered}×)`);
      alsoBought = relevant.slice(1, 4).map((e) => e.name);
    }
  }
  const qty = opts.qty ? Math.max(1, opts.qty) : usualQty;

  if (ref) {
    const norm = (x: string) => x.normalize("NFC").toLowerCase().trim();
    const same = results.find((r) => norm(r.name) === norm(ref!.name)) ?? liked?.product ?? (await findByName(http, ref.name)).product;
    if (same) {
      lines.push(`Still available: ${fmtProduct(same)}`);
      return { choice: same, qty, lines, alsoBought, options: [] };
    }
    lines.push("Not sold any more – closest match:");
    const pool = results.length ? results : await search(http, ref.name.split(",")[0], 300);
    const c = await chooseSubstitute(ref, pool, { useLlm: opts.useLlm ?? true });
    if (!c.product) {
      lines.push(`No reasonable replacement: ${c.reason}`);
      return { choice: null, qty, lines, alsoBought, options: c.ranked.slice(0, 5).map((r) => r.product) };
    }
    lines.push(fmtProduct(c.product), `why: ${c.reason}`);
    return { choice: c.product, qty, lines, alsoBought, options: [] };
  }
  if (opts.cheapest) {
    const [cheapest] = await findCheapest(http, query);
    if (!cheapest) return { choice: null, qty, lines: ["No matching products"], alsoBought, options: [] };
    lines.push(`No history for "${query}" – cheapest: ${fmtProduct(cheapest)}`);
    return { choice: cheapest, qty, lines, alsoBought, options: [] };
  }
  lines.push(`No history for "${query}".`);
  return { choice: null, qty, lines, alsoBought, options: results.slice(0, 8) };
}
