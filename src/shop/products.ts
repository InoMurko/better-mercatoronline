/**
 * Products: GET /products/browseProducts/getProducts (docs/mercator-api.md §3).
 * Concurrency: result pages after the first are fetched in parallel; alternative queries run in parallel;
 * identical queries within 10 minutes are served from a small cache.
 */
import { Http } from "../core/http.ts";
import { parseOffers, type Offer, type RawDiscount } from "../app/offers.ts";

export type Product = {
  id: string;
  name: string;
  /** price per piece you pay – includes straight and Pika discounts */
  price: number;
  unitPrice: number | null;
  unitBase: string | null;
  brand: string | null;
  regularPrice?: number | null;
  offers?: Offer[];
  gtin?: string | null;
  /** "CATEGORY2 > CATEGORY3" */
  category: string;
  url: string;
};

/** One entry of the endpoint's `products` array → Product (null for banners etc.). */
export function toProduct(p: any): Product | null {
  if (p?.type !== "product" || !p.data) return null;
  const d = p.data;
  const price = Number(d.current_price);
  return {
    id: String(p.itemId),
    name: String(d.name),
    price,
    regularPrice: Number(d.normal_price) > price ? Number(d.normal_price) : null,
    unitPrice: d.price_per_unit ? Number(d.price_per_unit) : null,
    unitBase: d.price_per_unit_base || null,
    brand: d.brand_name || null,
    category: [d.category2, d.category3].filter(Boolean).join(" > "),
    url: String(p.url),
    gtin: d.gtins?.[0]?.gtin ?? null,
    offers: parseOffers((d.discounts ?? []) as RawDiscount[]),
  };
}

const PAGE = 100;
const cache = new Map<string, { at: number; value: Promise<Product[]> }>();

function listingUrl(filter: Record<string, string>, offset: number) {
  const q = new URLSearchParams({ limit: String(PAGE), offset: String(offset), from: String(offset) });
  for (const [k, v] of Object.entries(filter)) q.set(`filterData[${k}]`, v);
  return `/products/browseProducts/getProducts?${q}`;
}

/** Any listing (search, category, discounts), up to `max` results. Pages 2…n are fetched in parallel. */
export async function listing(http: Http, filter: Record<string, string>, max = PAGE): Promise<Product[]> {
  const key = `${JSON.stringify(filter)}|${max}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
  const value = (async () => {
    const first = await http.json<{ products?: any[] }>(listingUrl(filter, 0));
    const raw = first.products ?? [];
    const total = Math.min(max, Number(raw.find((p) => p?.total != null)?.total ?? raw.length));
    const offsets: number[] = [];
    if (raw.length >= PAGE) for (let o = PAGE; o < total; o += PAGE) offsets.push(o);
    const rest = await Promise.all(offsets.map((o) => http.json<{ products?: any[] }>(listingUrl(filter, o)).then((r) => r.products ?? [])));
    return [raw, ...rest].flat().map(toProduct).filter((p): p is Product => !!p).slice(0, max);
  })();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

export const search = (http: Http, query: string, max = PAGE) => listing(http, { search: query }, max);

const norm = (s: string) => s.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();

/** Full name first; then without size/percentage parts (the search chokes on those); then brand + word. */
export function exactNameQueries(name: string): string[] {
  const plain = name.split(/,\s+/).filter((seg) => !/\d|%/.test(seg));
  const words = plain.join(" ").split(/\s+/).filter((w) => w.length > 2);
  const caps = words.filter((w) => /^[A-ZČŠŽĆĐ]/.test(w));
  return [
    ...new Set([
      name,
      plain.join(" "),
      plain.join(" ").replace(/[^\p{L}\s]/gu, " ").replace(/\s+/g, " "),
      ...caps.flatMap((c) => words.filter((w) => w !== c).slice(0, 3).map((w) => `${c} ${w}`)),
      ...caps,
    ]),
  ].filter(Boolean);
}

/**
 * Find a product by its exact name. The first two queries (full name, name without sizes) run in parallel –
 * they find almost everything; the looser ones only if needed.
 */
export async function findByName(http: Http, name: string): Promise<{ product: Product | null; candidates: Product[] }> {
  const queries = exactNameQueries(name);
  const exact = (hits: Product[]) => hits.find((h) => norm(h.name) === norm(name)) ?? null;
  const firstTwo = await Promise.all(queries.slice(0, 2).map((q) => search(http, q)));
  for (const hits of firstTwo) {
    const p = exact(hits);
    if (p) return { product: p, candidates: [] };
  }
  for (const q of queries.slice(2)) {
    const p = exact(await search(http, q));
    if (p) return { product: p, candidates: [] };
  }
  return { product: null, candidates: firstTwo.flat().slice(0, 3) };
}

export type CheapestOptions = { categories?: string[]; by?: "unit" | "price" };

export async function findCheapest(http: Http, query: string, opts: CheapestOptions = {}): Promise<Product[]> {
  const cats = (opts.categories ?? []).map(norm);
  const hits = (await search(http, query, 1000)).filter((p) => p.price > 0 && (!cats.length || cats.some((c) => norm(p.category).includes(c))));
  if ((opts.by ?? "unit") === "price") return hits.sort((a, b) => a.price - b.price);
  const bases = new Map<string, number>();
  for (const p of hits) if (p.unitBase) bases.set(p.unitBase, (bases.get(p.unitBase) ?? 0) + 1);
  const base = [...bases.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const key = (p: Product) => (p.unitPrice != null && p.unitBase === base ? p.unitPrice : Infinity);
  return hits.sort((a, b) => key(a) - key(b) || a.price - b.price);
}

/** Products that could replace `name`: the looser name queries, in parallel, de-duplicated. */
export async function similarCandidates(http: Http, name: string, maxQueries = 3): Promise<Product[]> {
  const results = await Promise.all(exactNameQueries(name).slice(1, 1 + maxQueries).map((q) => search(http, q, 200)));
  const seen = new Map<string, Product>();
  for (const p of results.flat()) seen.set(p.id, p);
  return [...seen.values()].filter((p) => norm(p.name) !== norm(name));
}
