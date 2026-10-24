/**
 * "Is this the same kind of product?" scoring, generic across product types.
 *
 * Signals (all read from the product name + shop data):
 *  - distinctive words: words that separate products *within the candidate set* weigh most
 *    (vlažni, grški, skyr, trajno, brez laktoze, …); words every candidate shares (papir, mleko) weigh little
 *  - percentages (fat "3,5 % m.m.", alcohol "5,5 %") and ply ("3-slojni") must match
 *  - same shop category, same brand / brand family
 *  - similar package size and pack count
 *  - similar price per unit; much cheaper is penalised as a likely quality drop
 */
import type { Product } from "../shop/products.ts";

/** What we compare against: a product you bought before (full data) or just a name + price from an e-mail. */
export type Reference = Pick<Product, "name" | "price"> & Partial<Omit<Product, "name" | "price">>;

export type Scored = { product: Product; score: number; reasons: string[] };

const STOP = new Set(["in", "z", "s", "za", "iz", "na", "v", "ali", "kos", "kosi", "kosov", "rolic", "ml", "kg", "pakirano", "zop"]);
export const stem = (w: string) => w.slice(0, 4);

export function words(name: string): string[] {
  return name
    .normalize("NFC")
    .toLowerCase()
    .replace(/\d+\s*-?\s*slo(?:jn|nj)i/g, " ") // ply is handled separately
    .split(/[^\p{L}]+/u)
    .filter((w) => w.length >= 2 && !STOP.has(w));
}
/** Word stems of the name, without the brand's own words (brand is scored separately). */
const stems = (name: string, brand?: string | null) => {
  const brandStems = new Set(words(brand ?? "").map(stem));
  return new Set(words(name).map(stem).filter((s) => !brandStems.has(s)));
};

const num = (s: string) => Number(s.replace(",", "."));

export function attributes(name: string) {
  const ply = name.match(/(\d)\s*-?\s*slo(?:jn|nj)i/i);
  const percents = [...name.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)].map((m) => num(m[1]));
  const size = name.match(/(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l)\b/i);
  const pack = name.match(/(\d+)\s*\/\s*1\b/) ?? name.match(/(\d+)\s*(?:kosov|kosi|rolic|kom)\b/i);
  let sizeBase: number | null = null;
  if (size) {
    const unit = size[2].toLowerCase();
    sizeBase = num(size[1]) * (unit === "kg" || unit === "l" ? 1000 : 1);
  }
  return {
    ply: ply ? Number(ply[1]) : null,
    percents,
    size: sizeBase,
    pack: pack ? Number(pack[1]) : null,
  };
}

export const categoryTail = (c?: string | null) => (c ? c.split(" > ").pop()!.trim().toUpperCase() : null);
const closeness = (a: number, b: number, span: number) => 1 - Math.min(Math.abs(Math.log(b / a)) / Math.log(span), 1);
const fmtPct = (p: number[]) => p.map((x) => `${String(x).replace(".", ",")} %`).join("/");

/** Score every candidate against the reference, best first. */
export function rankSimilar(ref: Reference, candidates: Product[]): Scored[] {
  // inverse document frequency of each word stem within this candidate set
  const docs = candidates.map((c) => stems(c.name, c.brand));
  const df = new Map<string, number>();
  for (const d of docs) for (const s of d) df.set(s, (df.get(s) ?? 0) + 1);
  const idf = (s: string) => Math.log((candidates.length + 1) / ((df.get(s) ?? 0) + 1)) + 0.1;

  const refStems = stems(ref.name, ref.brand);
  const refAttr = attributes(ref.name);
  const refCat = categoryTail(ref.category);
  const refBrand = ref.brand?.toUpperCase() ?? null;

  const scored = candidates.map((product, i): Scored => {
    const reasons: string[] = [];
    let score = 0;
    const attr = attributes(product.name);

    // 1. distinctive words (weighted Jaccard)
    const cs = docs[i];
    let inter = 0;
    let union = 0;
    for (const s of new Set([...refStems, ...cs])) {
      union += idf(s);
      if (refStems.has(s) && cs.has(s)) inter += idf(s);
    }
    const wj = union ? inter / union : 0;
    score += 6 * wj;
    const missing = [...refStems].filter((s) => !cs.has(s) && idf(s) > 1);
    if (missing.length) reasons.push(`lacks "${words(ref.name).filter((w) => missing.includes(stem(w))).join(", ")}"`);

    // 2. same category
    const cat = categoryTail(product.category);
    if (refCat && cat) {
      if (refCat === cat) score += 1.5;
      else {
        score -= 2;
        reasons.push(`other category (${cat.toLowerCase()})`);
      }
    }

    // 3. percentages (fat, alcohol) and ply must match
    if (refAttr.percents.length) {
      if (!attr.percents.length) score -= 1;
      else if (refAttr.percents.every((p) => attr.percents.some((q) => Math.abs(p - q) < 0.05))) {
        score += 2;
        reasons.push(`same ${fmtPct(refAttr.percents)}`);
      } else {
        score -= 6;
        reasons.push(`${fmtPct(attr.percents)} instead of ${fmtPct(refAttr.percents)}`);
      }
    }
    if (refAttr.ply != null) {
      if (attr.ply === refAttr.ply) {
        score += 1.5;
        reasons.push(`${attr.ply}-ply`);
      } else if (attr.ply != null) {
        score -= 3;
        reasons.push(`${attr.ply}-ply instead of ${refAttr.ply}-ply`);
      }
    }

    // 4. brand
    const brand = product.brand?.toUpperCase() ?? null;
    if (refBrand && brand) {
      if (brand === refBrand) {
        score += 1.5;
        reasons.push("same brand");
      } else if (brand.split(" ")[0] === refBrand.split(" ")[0]) {
        score += 0.75;
        reasons.push(`same brand family (${brand.toLowerCase()})`);
      }
    }

    // 5. size / pack
    if (refAttr.size && attr.size) score += closeness(refAttr.size, attr.size, 4);
    if (refAttr.pack && attr.pack) score += 0.5 * closeness(refAttr.pack, attr.pack, 4);

    // 6. price: per unit when comparable, else per package; much cheaper ≈ lower quality
    const comparableUnit =
      ref.unitPrice != null && product.unitPrice != null && ref.unitBase === product.unitBase;
    const ratio = comparableUnit ? product.unitPrice! / ref.unitPrice! : product.price / ref.price;
    if (Number.isFinite(ratio) && ratio > 0) {
      score += 2.5 * closeness(1, ratio, 2.5);
      if (ratio < 0.7) {
        score -= ratio < 0.33 ? 4.5 : 1.5;
        reasons.push(`${Math.round((1 - ratio) * 100)} % cheaper${comparableUnit ? " per unit" : ""} – may be lower quality`);
      } else if (ratio > 1.5) {
        // a several-times price gap per unit usually means a different kind of product (wet wipes vs rolls)
        if (ratio > 3) score -= 3;
        reasons.push(`${Math.round((ratio - 1) * 100)} % pricier${comparableUnit ? " per unit" : ""}`);
      } else {
        reasons.push(`similar price${comparableUnit ? " per unit" : ""}`);
      }
    }

    return { product, score: Math.round(score * 100) / 100, reasons };
  });

  return scored.sort((a, b) => b.score - a.score);
}
