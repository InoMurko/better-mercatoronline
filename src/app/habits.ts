/**
 * Shopping habits: how fast you go through each *kind* of product, and when you'll run out.
 *
 * - Products are grouped into families (all the wet toilet papers you've bought; 3,5 % long-life milk; skyr …)
 *   so switching brands doesn't look like a new habit. Groups can be corrected in families.json.
 * - Amounts are counted in what you consume (rolls / wipes / ml / g), not in packages.
 * - Consumption rate = median over your purchase intervals of (amount bought ÷ days until the next purchase),
 *   so one holiday or one stock-up doesn't skew it.
 */
import { existsSync, readFileSync } from "node:fs";
import type { HistoryEntry } from "./history.ts";
import { attributes, categoryTail, stem, words } from "./similarity.ts";

export const FAMILIES_FILE = "families.json";
const DAY = 86_400_000;

/** How much of the consumable one package holds: rolls/wipes for packs ("10/1", "60 kosov"), ml/g for sizes, else 1 piece. */
export function contentOf(name: string): { amount: number; unit: string } {
  const a = attributes(name);
  if (a.pack) return { amount: a.pack, unit: "kos" };
  if (a.size) return { amount: a.size, unit: /\d\s*(ml|l)\b/i.test(name) ? "ml" : "g" };
  return { amount: 1, unit: "pakiranje" };
}

/** The "what is it" part of the name: first segment without brand words, e.g. "Vlažni toaletni papir Hemo care". */
function typeStems(e: HistoryEntry): Set<string> {
  const brand = new Set(words(e.product?.brand ?? "").map(stem));
  return new Set(words(e.name.split(/,\s+/)[0]).map(stem).filter((s) => !brand.has(s)));
}

function compatible(a: HistoryEntry, b: HistoryEntry): boolean {
  const ca = categoryTail(a.product?.category);
  const cb = categoryTail(b.product?.category);
  if (ca && cb && ca !== cb) return false;
  const aa = attributes(a.name);
  const ab = attributes(b.name);
  if (aa.percents.length && ab.percents.length && aa.percents.join() !== ab.percents.join()) return false;
  if (aa.ply != null && ab.ply != null && aa.ply !== ab.ply) return false;
  if (contentOf(a.name).unit !== contentOf(b.name).unit) return false;
  const ua = a.product?.unitPrice;
  const ub = b.product?.unitPrice;
  if (ua && ub && a.product?.unitBase === b.product?.unitBase && Math.max(ua / ub, ub / ua) > 3) return false;
  const ta = typeStems(a);
  const tb = typeStems(b);
  const inter = [...ta].filter((s) => tb.has(s)).length;
  const union = new Set([...ta, ...tb]).size;
  return union > 0 && inter / union >= 0.5;
}

export type Family = { label: string; members: HistoryEntry[] };

/** Manual corrections: { "Family label": ["exact product name", …] } – listed products always go to that family. */
function loadOverrides(): Map<string, string> {
  if (!existsSync(FAMILIES_FILE)) return new Map();
  const json: Record<string, string[]> = JSON.parse(readFileSync(FAMILIES_FILE, "utf8"));
  return new Map(Object.entries(json).flatMap(([label, names]) => names.map((n) => [n, label] as [string, string])));
}

export function groupFamilies(history: HistoryEntry[], overrides = loadOverrides()): Family[] {
  const families: Family[] = [];
  const byLabel = new Map<string, Family>();
  // oldest habits first, so a family is labelled after the product you started with
  const sorted = [...history].sort((a, b) => (a.purchases[0]?.date ?? "").localeCompare(b.purchases[0]?.date ?? ""));
  for (const e of sorted) {
    const forced = overrides.get(e.name);
    if (forced) {
      const f = byLabel.get(forced) ?? { label: forced, members: [] };
      if (!byLabel.has(forced)) {
        byLabel.set(forced, f);
        families.push(f);
      }
      f.members.push(e);
      continue;
    }
    const home = families.find((f) => !byLabel.has(f.label) && f.members.some((m) => compatible(m, e)));
    if (home) home.members.push(e);
    else families.push({ label: e.name, members: [e] });
  }
  return families;
}

export type Habit = {
  family: Family;
  unit: string;
  /** purchases merged per day, oldest first */
  events: { date: string; amount: number }[];
  /** consumption per day, null when there's too little history */
  ratePerDay: number | null;
  typicalAmount: number;
  medianIntervalDays: number | null;
  lastDate: string;
  daysSinceLast: number;
  /** estimated amount left at home */
  remaining: number | null;
  runsOutInDays: number | null;
  /** product to buy next time: the one bought most recently */
  usual: HistoryEntry;
  status: "due" | "soon" | "ok" | "dormant" | "too-few";
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY);

export function habitOf(family: Family, today: string, horizonDays: number, lookbackDays = 365): Habit {
  const unit = contentOf(family.members[0].name).unit;
  const perDay = new Map<string, number>();
  let usual = family.members[0];
  let usualDate = "";
  for (const m of family.members) {
    const content = contentOf(m.name).amount;
    for (const p of m.purchases) {
      perDay.set(p.date, (perDay.get(p.date) ?? 0) + p.quantity * content);
      if (p.date >= usualDate) {
        usualDate = p.date;
        usual = m;
      }
    }
  }
  let events = [...perDay.entries()].map(([date, amount]) => ({ date, amount })).sort((a, b) => a.date.localeCompare(b.date));
  // prefer the last year when it has enough data – habits change
  const recent = events.filter((e) => days(e.date, today) <= lookbackDays);
  if (recent.length >= 3) events = recent;

  const last = events.at(-1)!;
  const daysSinceLast = days(last.date, today);
  const typicalAmount = median(events.map((e) => e.amount));
  const base = { family, unit, events, typicalAmount, lastDate: last.date, daysSinceLast, usual };

  if (events.length < 3) {
    return { ...base, ratePerDay: null, medianIntervalDays: null, remaining: null, runsOutInDays: null, status: "too-few" };
  }
  const intervals = events.slice(1).map((e, i) => Math.max(1, days(events[i].date, e.date)));
  const ratePerDay = median(intervals.map((d, i) => events[i].amount / d));
  const medianIntervalDays = median(intervals);
  const remaining = Math.max(0, last.amount - ratePerDay * daysSinceLast);
  const runsOutInDays = remaining / ratePerDay;

  let status: Habit["status"];
  if (daysSinceLast > Math.max(3 * medianIntervalDays, 60)) status = "dormant";
  else if (runsOutInDays <= horizonDays) status = "due";
  else if (runsOutInDays <= horizonDays + 7) status = "soon";
  else status = "ok";
  return { ...base, ratePerDay, medianIntervalDays, remaining, runsOutInDays, status };
}

export function habits(history: HistoryEntry[], today: string, horizonDays = 7, overrides?: Map<string, string>): Habit[] {
  const order = { due: 0, soon: 1, ok: 2, dormant: 3, "too-few": 4 };
  return groupFamilies(history.filter((e) => e.purchases.length), overrides)
    .map((f) => habitOf(f, today, horizonDays))
    .sort((a, b) => order[a.status] - order[b.status] || (a.runsOutInDays ?? 1e9) - (b.runsOutInDays ?? 1e9));
}

/** How many packages of `name` cover your usual purchase amount for this habit. */
export function packagesFor(h: Habit, name: string): number {
  const c = contentOf(name);
  if (c.unit !== h.unit) return Math.max(1, Math.round(h.typicalAmount / contentOf(h.usual.name).amount));
  return Math.max(1, Math.round(h.typicalAmount / c.amount));
}
