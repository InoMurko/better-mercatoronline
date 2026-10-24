/** Habits → what's due → a cart plan → add it. Shared by the CLI and the Telegram bot. */
import { Http } from "../core/http.ts";
import { mapLimit } from "../core/limiter.ts";
import { addMany, readCart, type CartLine } from "../shop/cart.ts";
import { findByName, similarCandidates, type Product } from "../shop/products.ts";
import { chooseSubstitute } from "./choose.ts";
import { habits, packagesFor, type Habit } from "./habits.ts";
import { historyIsStale, loadHistory, rebuildHistory } from "./history.ts";

export const today = () => new Date().toISOString().slice(0, 10);
export const defaultHorizon = () => Number(process.env.RESTOCK_HORIZON_DAYS) || 7;

/** note: "your usual" or why a replacement was picked; why: why it's in the basket at all */
export type CartItem = { product: Product; qty: number; note: string; why?: string };

export async function loadHabits(http: Http, opts: { today?: string; horizon?: number; historyLookups?: number } = {}): Promise<Habit[]> {
  let history = loadHistory();
  if (historyIsStale()) history = await rebuildHistory(http, { maxLookups: opts.historyLookups });
  if (!history.some((e) => e.purchases.length)) throw new Error("No dated orders yet – run `npm run cli -- import` first");
  return habits(history, opts.today ?? today(), opts.horizon ?? defaultHorizon());
}

export const fmtAmount = (n: number, unit: string) =>
  unit === "ml" ? `${+(n / 1000).toFixed(1)} l` : unit === "g" ? (n >= 1000 ? `${+(n / 1000).toFixed(1)} kg` : `${Math.round(n)} g`) : `${Math.round(n)} ${unit}`;

export function describeHabit(h: Habit): [string, string] {
  const head = `${h.usual.name}${h.family.members.length > 1 ? ` (+${h.family.members.length - 1} similar)` : ""}`;
  if (h.status === "too-few") return [head, `bought ${h.events.length}× – not enough history yet (last ${h.lastDate})`];
  const every = `every ~${Math.round(h.medianIntervalDays!)} days, ~${fmtAmount(h.typicalAmount, h.unit)} each`;
  if (h.status === "dormant") return [head, `used to buy ${every}; nothing since ${h.lastDate} – looks like you stopped`];
  const out = h.runsOutInDays! < 0.5 ? "probably already out" : `runs out in ~${Math.round(h.runsOutInDays!)} days`;
  return [head, `${every}; last ${h.lastDate} → ~${fmtAmount(h.remaining!, h.unit)} left, ${out}`];
}

export function whyOf(h: Habit): string {
  const every = h.medianIntervalDays ? `you buy it every ~${Math.round(h.medianIntervalDays)} days` : "";
  if (h.runsOutInDays != null && h.runsOutInDays < 0.5) return `probably already out (${every})`;
  const when = `runs out in ~${Math.round(h.runsOutInDays ?? 0)} days`;
  return h.status === "soon" ? `${when} – added now so you don't need another delivery soon` : `${when} (${every})`;
}

/** For each habit: your usual product if still sold, else the closest replacement; in your usual amount. Runs in parallel. */
export async function planRestock(http: Http, due: Habit[], opts: { useLlm?: boolean } = {}): Promise<{ items: CartItem[]; unavailable: string[] }> {
  const planned = await mapLimit(due, 4, async (h): Promise<CartItem | string> => {
    let { product } = await findByName(http, h.usual.name);
    let note = "your usual";
    if (!product) {
      const ref = h.usual.product ?? { name: h.usual.name, price: h.usual.lastPrice };
      const c = await chooseSubstitute(ref, await similarCandidates(http, h.usual.name), { useLlm: opts.useLlm ?? true });
      product = c.product;
      note = `replaces ${h.usual.name} – ${c.reason}`;
    }
    return product ? { product, qty: packagesFor(h, product.name), note, why: whyOf(h) } : h.usual.name;
  });
  return {
    items: planned.filter((p): p is CartItem => typeof p !== "string"),
    unavailable: planned.filter((p): p is string => typeof p === "string"),
  };
}

/** Everything due, plus (by default) what runs out the week after – one delivery for both. */
export async function buildBasket(http: Http, opts: { horizon?: number; includeSoon?: boolean; historyLookups?: number; useLlm?: boolean } = {}) {
  const all = await loadHabits(http, { horizon: opts.horizon, historyLookups: opts.historyLookups });
  const due = all.filter((h) => h.status === "due");
  const soon = all.filter((h) => h.status === "soon");
  const want = opts.includeSoon === false ? due : [...due, ...soon];
  const plan = want.length ? await planRestock(http, want, { useLlm: opts.useLlm }) : { items: [], unavailable: [] };
  return { ...plan, due, soon };
}

/** Add items (one verified request per product, see cart.ts), then read the cart once to check. */
export async function addItems(
  http: Http,
  items: CartItem[],
  progress?: (done: number, total: number) => void,
): Promise<{ ok: boolean; added: number; failed: CartItem[]; problems: string[]; cart: CartLine[] }> {
  const results = await addMany(http, items, progress);
  const failed = items.filter((_, i) => !results[i].ok);
  const problems = items.flatMap((it, i) => (results[i].ok ? [] : [`${it.product.name}: ${results[i].note ?? "not added"}`]));
  const cart = await readCart(http).catch(() => [] as CartLine[]);
  return { ok: !failed.length, added: items.length - failed.length, failed, problems, cart };
}
