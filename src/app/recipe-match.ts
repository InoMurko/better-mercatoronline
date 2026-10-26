/**
 * Ingredients → real Mercator products → a recipe basket you edit before anything reaches the cart.
 *
 * - candidates always come from the shop's own search; a product can only be one of those
 * - the AI pick sees only the cleaned search terms and the shop's product names (never the page text),
 *   and must answer with an id from the shortlist – anything else is ignored
 * - pack counts are worked out by code from the product's size; unusual amounts are flagged, and capped
 * - pantry staples, optional lines, and things your habits say you still have start as "at home"
 */
import { model, recipeAi, type Ai } from "./ai.ts";
import { z } from "zod";
import type { Http } from "../core/http.ts";
import { mapLimit } from "../core/limiter.ts";
import { search, type Product } from "../shop/products.ts";
import { contentOf, type Habit } from "./habits.ts";
import { stem, words } from "./similarity.ts";
import { parseIngredients, type Ingredient } from "./recipe-ai.ts";
import { extractRecipe } from "./recipe.ts";
import { safeFetchHtml, type SafeFetchOptions } from "../core/safe-fetch.ts";
import type { CartItem } from "./restock.ts";

export const MAX_PACKS = 6;

export type RecipeLine = {
  ingredient: Ingredient;
  /** the page's own text for this line (shown to you, escaped) */
  original: string;
  product: Product | null;
  /** packages for the recipe's servings */
  qty: number;
  /** true = goes in the basket; false = at home / skipped */
  include: boolean;
  /** why it starts out excluded, or a note on the pick */
  why: string;
  /** something you should look at (big amount, weak match) */
  flag?: string;
  options: Product[];
};

export type RecipePlan = { title: string | null; servings: number | null; baseServings: number | null; lines: RecipeLine[]; url: string };

/** Recipe amount → grams/millilitres/pieces (rough kitchen conversions). */
export function needed(i: Ingredient): { amount: number; unit: "g" | "ml" | "pcs" } | null {
  if (i.amount == null || !i.unit) return null;
  const a = i.amount;
  switch (i.unit) {
    case "g": return { amount: a, unit: "g" };
    case "ml": return { amount: a, unit: "ml" };
    case "tbsp": return { amount: a * 15, unit: "ml" };
    case "tsp": return { amount: a * 5, unit: "ml" };
    case "cup": return { amount: a * 240, unit: "ml" };
    case "pinch": return { amount: a * 0.5, unit: "g" };
    case "pcs": return { amount: a, unit: "pcs" };
    default: return null; // clove, can, pack, bunch, slice → one package
  }
}

/** How many packages of `p` cover what the recipe needs (× scale for servings). Capped; big numbers flagged. */
export function packsFor(i: Ingredient, p: Product, scale = 1): { qty: number; flag?: string } {
  const need = needed(i);
  const c = contentOf(p.name);
  let qty = 1;
  if (need) {
    const amount = need.amount * scale;
    if ((need.unit === "g" || need.unit === "ml") && (c.unit === "g" || c.unit === "ml")) qty = Math.ceil(amount / c.amount - 0.05);
    else if (need.unit === "pcs" && c.unit === "kos") qty = Math.ceil(amount / c.amount - 0.05);
    else if (need.unit === "pcs" && c.unit === "pakiranje") qty = Math.ceil(amount - 0.05);
  } else if ((i.unit === "can" || i.unit === "pack") && i.amount) qty = Math.ceil(i.amount * scale);
  qty = Math.max(1, qty);
  if (qty > MAX_PACKS) return { qty: MAX_PACKS, flag: `would need ${qty} packs – capped at ${MAX_PACKS}, check it` };
  if (qty > 3) return { qty, flag: `${qty} packs – check the amount` };
  return { qty };
}

const stemsOf = (s: string) => words(s).map(stem);

/** Rank shop results for a search term: the term's words in the product's "what it is" part first, then things you've bought, then unit price. */
export function rankForIngredient(term: string, candidates: Product[], boughtBefore: Set<string> = new Set()): Product[] {
  const want = stemsOf(term);
  const score = (p: Product) => {
    const head = new Set(stemsOf(p.name.split(/,\s+/)[0]));
    const all = new Set(stemsOf(p.name));
    let s = 0;
    for (const w of want) s += head.has(w) ? 2 : all.has(w) ? 1 : 0;
    if (want.length && want.every((w) => head.has(w))) s += 2;
    if (boughtBefore.has(p.name)) s += 3;
    return s;
  };
  return candidates
    .map((p) => ({ p, s: score(p) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (a.p.unitPrice ?? a.p.price) - (b.p.unitPrice ?? b.p.price))
    .map((x) => x.p);
}

/** One call for the whole recipe: for each ingredient, pick the best product id from its own shortlist, or null. */
async function aiPick(ai: Ai, entries: { key: number; label: string; options: Product[] }[]): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>();
  if (!entries.length) return out;
  const list = entries
    .map((e) => [`#${e.key} ${e.label}`, ...e.options.map((p) => `   ${p.id} | ${p.name} | ${p.price.toFixed(2)} € | ${p.category}`)].join("\n"))
    .join("\n");
  const msg = await ai.messages.create({
    model: model(),
    max_tokens: 2000,
    system:
      "For each ingredient, pick the grocery product a home cook would buy for it from that ingredient's own candidate list " +
      "(right kind of product, sensible pack size, ordinary quality; not a ready meal or a different ingredient), or null if none fits. " +
      "Answer only with the pick tool.",
    tools: [
      {
        name: "pick",
        description: "The chosen product per ingredient.",
        input_schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            picks: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: { key: { type: "integer" }, id: { type: ["string", "null"] } },
                required: ["key", "id"],
              },
            },
          },
          required: ["picks"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "pick" },
    messages: [{ role: "user", content: list }],
  });
  const call = msg.content.find((b) => b.type === "tool_use");
  const parsed = z
    .object({ picks: z.array(z.object({ key: z.number().int(), id: z.string().max(40).nullable() })).max(60) })
    .safeParse(call && call.type === "tool_use" ? call.input : null);
  if (!parsed.success) throw new Error("the AI's picks didn't pass the checks");
  for (const { key, id } of parsed.data.picks) {
    const e = entries.find((x) => x.key === key);
    // only ids from that ingredient's own shortlist count
    if (e && (id == null || e.options.some((p) => p.id === id))) out.set(key, id);
  }
  return out;
}

/** Which of your habits says you still have this product at home? */
function athome(p: Product, habits: Habit[]): string | null {
  const h = habits.find((x) => x.family.members.some((m) => m.name === p.name));
  if (!h) return null;
  if (h.status === "ok" && h.remaining != null) return `you bought it ${h.lastDate} – probably still have some`;
  return null;
}

export async function matchRecipe(
  http: Http,
  src: { url: string; title: string | null; lines: string[]; servings: number | null },
  ingredients: Ingredient[],
  opts: { ai?: Ai; habits?: Habit[]; boughtBefore?: Set<string>; servings?: number | null } = {},
): Promise<RecipePlan> {
  const ai = opts.ai ?? recipeAi();
  const habits = opts.habits ?? [];
  const bought = opts.boughtBefore ?? new Set(habits.flatMap((h) => h.family.members.map((m) => m.name)));
  const found = await mapLimit(ingredients, 4, async (ing) => {
    let results = await search(http, ing.search, 40).catch(() => [] as Product[]);
    let ranked = rankForIngredient(ing.search, results, bought);
    if (!ranked.length && ing.search.includes(" ")) {
      // "temna čokolada 70 %" finds nothing → try the main word
      const main = words(ing.search).sort((a, b) => b.length - a.length)[0];
      if (main) {
        results = await search(http, main, 40).catch(() => [] as Product[]);
        ranked = rankForIngredient(main, results, bought);
      }
    }
    return ranked.slice(0, 6);
  });

  // the AI chooses for every ingredient with candidates – and may say none fits
  const picks = await aiPick(
    ai,
    ingredients.flatMap((ing, k) => (found[k].length ? [{ key: k, label: `${ing.search}${ing.amount ? ` (${ing.amount} ${ing.unit ?? ""})` : ""}`, options: found[k] }] : [])),
  );

  const base = src.servings;
  const servings = opts.servings ?? base;
  const scale = base && servings ? servings / base : 1;
  const lines: RecipeLine[] = ingredients.map((ing, k) => {
    const options = found[k];
    const pickedId = picks.get(k) ?? null;
    const product = pickedId == null ? null : options.find((p) => p.id === pickedId) ?? null;
    const original = src.lines[ing.line] ?? ing.search;
    if (!product) return { ingredient: ing, original, product: null, qty: 0, include: false, why: "nothing suitable found in the shop", options };
    const { qty, flag } = packsFor(ing, product, scale);
    const home = ing.pantry ? "pantry staple – probably at home" : ing.optional ? "optional" : athome(product, habits);
    return { ingredient: ing, original, product, qty, include: !home, why: home ?? (bought.has(product.name) ? "you've bought this before" : ""), flag, options };
  });
  return { url: src.url, title: src.title, servings, baseServings: base, lines };
}

/** Change the servings: re-count packs for every line. */
export function rescale(plan: RecipePlan, servings: number): RecipePlan {
  const s = Math.max(1, Math.min(50, Math.round(servings)));
  const scale = plan.baseServings ? s / plan.baseServings : 1;
  return {
    ...plan,
    servings: s,
    lines: plan.lines.map((l) => (l.product ? { ...l, flag: undefined, ...packsFor(l.ingredient, l.product, scale) } : l)),
  };
}

export const toCartItems = (plan: RecipePlan): CartItem[] =>
  plan.lines
    .filter((l) => l.include && l.product && l.qty > 0)
    .map((l) => ({ product: l.product!, qty: l.qty, note: `recipe${plan.title ? `: ${plan.title}` : ""}`, why: l.original }));

// ---------- the whole flow ----------

const RECIPES_PER_DAY = () => Number(process.env.RECIPES_PER_DAY ?? 30);
const usage: number[] = [];

/** link → safe fetch → ingredient lines → shopping list → products. Nothing touches the cart. */
export async function recipeFromUrl(
  http: Http,
  url: string,
  opts: { ai?: Ai; habits?: Habit[]; servings?: number | null; fetch?: SafeFetchOptions; log?: (s: string) => void } = {},
): Promise<RecipePlan & { suspicious: string[]; source: "structured" | "page" }> {
  const ai = opts.ai ?? recipeAi(); // no key → fail before fetching anything
  const log = opts.log ?? console.log;
  const now = Date.now();
  while (usage.length && now - usage[0] > 86_400_000) usage.shift();
  if (usage.length >= RECIPES_PER_DAY()) throw new Error(`daily limit of ${RECIPES_PER_DAY()} recipes reached (RECIPES_PER_DAY)`);
  usage.push(now);

  const page = await safeFetchHtml(url, opts.fetch);
  const src = extractRecipe(page.html);
  log(`recipe ${page.url}${page.redirects.length ? ` (via ${page.redirects.length} redirect(s))` : ""}: ${src.kind}, ${src.lines.length} lines, "${src.title ?? "?"}"`);
  if (src.suspicious.length) log(`   ⚠ instruction-like text on the page: ${src.suspicious.map((s) => JSON.stringify(s)).join(", ")}`);
  if (!src.lines.length) throw new Error("couldn't find any ingredients on that page");
  const parsed = await parseIngredients(ai, src.lines);
  for (const i of parsed.ingredients) log(`   ${i.line}: ${JSON.stringify(src.lines[i.line])} → ${i.search} ${i.amount ?? ""}${i.unit ?? ""}${i.pantry ? " (pantry)" : ""}`);
  if (!parsed.ingredients.length) throw new Error("couldn't recognise any ingredients on that page");
  const plan = await matchRecipe(
    http,
    { url: page.url, title: src.title, lines: src.lines, servings: src.servings ?? parsed.servings },
    parsed.ingredients,
    { ai, habits: opts.habits, servings: opts.servings },
  );
  return { ...plan, suspicious: src.suspicious, source: src.kind };
}
