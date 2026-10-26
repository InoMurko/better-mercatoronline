/**
 * Past orders from the account pages (docs/mercator-api.md §6), read with plain code.
 * The order list is one page; order details are fetched in parallel (MERCATOR_CONCURRENCY, default 4).
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Http } from "../core/http.ts";
import { mapLimit } from "../core/limiter.ts";
import { formatOrder, type OrderLine } from "../app/order.ts";
import { parseOrderDetails, parseOrderList, type ListedOrder } from "./pages.ts";

export const ORDERS_DIR = "orders";
const LIST_PATHS = ["/uporabnik/pretekli-nakupi"]; // the menu link "Moja naročila"; discovered again if it moves (at most 3 kept)

/** The order list. If the known address stops working, follow the account menu's "naročila" link. */
export async function listOrders(http: Http): Promise<ListedOrder[]> {
  for (const path of LIST_PATHS) {
    const res = await http.html(path).catch(() => null);
    const parsed = res && parseOrderList(res.text);
    if (parsed) return parsed;
  }
  const account = await http.html("/uporabnik/moj-racun");
  const link = account.text.match(/href="([^"]+)"[^>]*>\s*(?:Moja naročila|Pretekli nakupi|Zgodovina naročil)/i)?.[1];
  if (link) {
    const parsed = parseOrderList((await http.html(link)).text);
    if (parsed) {
      if (!LIST_PATHS.includes(link)) LIST_PATHS.unshift(link);
      LIST_PATHS.length = Math.min(LIST_PATHS.length, 3);
      return parsed;
    }
  }
  throw new Error("Couldn't read the order list – the account pages changed (docs/mercator-api.md §6)");
}

/**
 * A line is consistent when its total matches delivered × price, or ordered × price – the shop keeps the
 * ordered total on lines that weren't delivered ("Izdobavljena količina 0,00", "Skupaj 1,99 EUR").
 */
export const lineAddsUp = (l: { name: string; quantity: number; ordered: number; unitPrice: number; lineTotal: number | null }) =>
  l.name.length > 3 &&
  l.unitPrice > 0 &&
  l.lineTotal != null &&
  (Math.abs(l.quantity * l.unitPrice - l.lineTotal) <= 0.02 || Math.abs(l.ordered * l.unitPrice - l.lineTotal) <= 0.02);

/** One order's delivered lines (+ what wasn't delivered); null when the page doesn't add up. */
export async function orderLines(http: Http, detailsUrl: string): Promise<{ lines: OrderLine[]; notDelivered: string[] } | null> {
  const parsed = parseOrderDetails((await http.html(detailsUrl)).text);
  if (!parsed?.lines.length || !parsed.lines.every(lineAddsUp)) return null;
  return {
    lines: parsed.lines.filter((l) => l.quantity > 0).map(({ name, quantity, unitPrice }) => ({ name, quantity, unitPrice })),
    notDelivered: parsed.lines.filter((l) => l.quantity <= 0 && l.ordered > 0).map((l) => l.name),
  };
}

const fileTag = (no: string) => no.replace(/[^\w-]/g, "");
const imported = () =>
  new Set(existsSync(ORDERS_DIR) ? readdirSync(ORDERS_DIR).map((f) => f.match(/^\d{4}-\d{2}-\d{2}-(.+)\.txt$/)?.[1]).filter(Boolean) : []);

export type ImportResult = { found: number; added: string[]; failed: string[] };

/** Fetch orders not in orders/ yet – in parallel – and save each as orders/<date>-<nr>.txt. */
export async function importNewOrders(http: Http, opts: { max?: number; concurrency?: number; log?: (s: string) => void } = {}): Promise<ImportResult> {
  const log = opts.log ?? console.log;
  mkdirSync(ORDERS_DIR, { recursive: true, mode: 0o700 });
  const all = (await listOrders(http)).filter((o) => /potrjen|zaključen|dostavljen|izdobavljen/i.test(o.status));
  const done = imported();
  const todo = all.filter((o) => !done.has(fileTag(o.orderNo))).slice(0, opts.max ?? Infinity);
  log(`  ${all.length} orders, ${todo.length} new`);
  const result: ImportResult = { found: all.length, added: [], failed: [] };
  await mapLimit(todo, opts.concurrency ?? 4, async (o) => {
    try {
      const got = await orderLines(http, o.detailsUrl);
      if (!got) throw new Error("order page didn't add up – not saved");
      const { lines, notDelivered } = got;
      const file = join(ORDERS_DIR, `${o.date}-${fileTag(o.orderNo)}.txt`);
      const header = [`# date: ${o.date}`, `# order: ${o.orderNo}`, `# paid: ${o.paid ?? "?"}`, ...notDelivered.map((n) => `# not delivered: ${n}`)];
      writeFileSync(file, formatOrder(lines, header), { mode: 0o600 });
      const missing = notDelivered.length ? `, ${notDelivered.length} not delivered: ${notDelivered.join("; ")}` : "";
      result.added.push(`${o.date} #${o.orderNo} (${lines.length} products${missing})`);
      log(`  + ${file}: ${lines.length} products${missing}`);
    } catch (err) {
      result.failed.push(`${o.date} #${o.orderNo}`);
      log(`  ✗ ${o.orderNo}: ${err instanceof Error ? err.message : err}`);
    }
  });
  return result;
}
