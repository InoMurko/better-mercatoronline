/**
 * Purchase history from orders/*.txt → history.json, with a shop snapshot (category, brand, unit price…) per product.
 * Shop lookups run in parallel (bounded by the HTTP client's limit); only new / stale products are looked up;
 * progress is saved as it goes. Snapshots of discontinued products are kept for comparisons.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Http } from "../core/http.ts";
import { mapLimit } from "../core/limiter.ts";
import { readOrderText } from "./order.ts";
import { findByName, type Product } from "../shop/products.ts";
import { ORDERS_DIR } from "../shop/orders.ts";
import { categoryTail, stem, words } from "./similarity.ts";

export const HISTORY_FILE = "history.json";
export type Purchase = { date: string; quantity: number; unitPrice: number };
export type HistoryEntry = {
  name: string;
  purchases: Purchase[];
  timesOrdered: number;
  totalQuantity: number;
  lastPrice: number;
  lastOrderFile: string;
  product: Product | null;
  /** when the shop was last searched for this product (YYYY-MM-DD) */
  checkedAt?: string;
};

const REFRESH_FOUND_DAYS = 30;
const RETRY_MISSING_DAYS = 7;
const today = () => new Date().toISOString().slice(0, 10);
const daysSince = (d: string) => (Date.parse(today()) - Date.parse(d)) / 86_400_000;

export function orderFiles(): string[] {
  if (!existsSync(ORDERS_DIR)) return [];
  return readdirSync(ORDERS_DIR).filter((f) => f.endsWith(".txt")).sort().map((f) => join(ORDERS_DIR, f));
}
export function loadHistory(): HistoryEntry[] {
  return existsSync(HISTORY_FILE) ? JSON.parse(readFileSync(HISTORY_FILE, "utf8")) : [];
}
const save = (list: HistoryEntry[]) => writeFileSync(HISTORY_FILE, JSON.stringify(list, null, 2) + "\n", { mode: 0o600 });

/** Order files newer than history.json (or no history yet). */
export function historyIsStale(): boolean {
  const files = orderFiles();
  if (!files.length) return false;
  if (!existsSync(HISTORY_FILE)) return true;
  const built = statSync(HISTORY_FILE).mtimeMs;
  return files.some((f) => statSync(f).mtimeMs > built);
}

function needsLookup(entries: HistoryEntry[]): HistoryEntry[] {
  return entries
    .filter((e) => !e.checkedAt || daysSince(e.checkedAt) >= (e.product ? REFRESH_FOUND_DAYS : RETRY_MISSING_DAYS))
    .sort((a, b) => b.timesOrdered - a.timesOrdered);
}
export const pendingLookups = () => needsLookup(loadHistory()).length;

/** Aggregate orders/ (instant, local), then look up to `maxLookups` new/stale products in parallel. */
export async function rebuildHistory(http: Http, opts: { maxLookups?: number; concurrency?: number; log?: (s: string) => void } = {}): Promise<HistoryEntry[]> {
  const log = opts.log ?? console.log;
  const previous = new Map(loadHistory().map((e) => [e.name, e]));
  const entries = new Map<string, HistoryEntry>();
  for (const file of orderFiles()) {
    const order = readOrderText(readFileSync(file, "utf8"), file);
    for (const line of order.lines) {
      const prev = previous.get(line.name);
      const e = entries.get(line.name) ?? {
        name: line.name, purchases: [], timesOrdered: 0, totalQuantity: 0, lastPrice: line.unitPrice, lastOrderFile: file,
        product: prev?.product ?? null, checkedAt: prev?.checkedAt,
      };
      if (order.date) e.purchases.push({ date: order.date, quantity: line.quantity, unitPrice: line.unitPrice });
      e.timesOrdered += 1;
      e.totalQuantity += line.quantity;
      e.lastPrice = line.unitPrice;
      e.lastOrderFile = file;
      entries.set(line.name, e);
    }
  }
  for (const e of entries.values()) e.purchases.sort((a, b) => a.date.localeCompare(b.date));
  const list = [...entries.values()].sort((a, b) => b.timesOrdered - a.timesOrdered);
  save(list);

  const todo = needsLookup(list).slice(0, opts.maxLookups ?? Infinity);
  if (!todo.length) return list;
  log(`→ Looking up ${todo.length} products (new or not checked recently)`);
  let done = 0;
  await mapLimit(todo, opts.concurrency ?? 4, async (e) => {
    const { product } = await findByName(http, e.name).catch(() => ({ product: null }));
    if (product) e.product = product;
    e.checkedAt = today();
    if (++done % 25 === 0) {
      save(list);
      log(`   ${done}/${todo.length}`);
    }
  });
  save(list);
  return list;
}

/** History entries that answer a search (name contains the query words, or same category as matching results). */
export function relevantHistory(history: HistoryEntry[], query: string, results: Product[]): HistoryEntry[] {
  const q = words(query).map(stem);
  const nameMatches = (name: string) => {
    const s = new Set(words(name).map(stem));
    return q.every((w) => s.has(w));
  };
  const cats = new Set(results.filter((r) => nameMatches(r.name)).map((r) => categoryTail(r.category)));
  return history
    .map((e) => ({ e, byName: nameMatches(e.name), byCat: !!e.product && cats.has(categoryTail(e.product.category)) }))
    .filter((x) => x.byName || x.byCat)
    .sort((a, b) => Number(b.byName) - Number(a.byName) || b.e.timesOrdered - a.e.timesOrdered || b.e.totalQuantity - a.e.totalQuantity)
    .map((x) => x.e);
}
