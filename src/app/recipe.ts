/**
 * Recipe page → ingredient lines. Plain code, no AI.
 *
 * 1. Structured data first: most recipe sites publish a schema.org Recipe as JSON-LD for search engines.
 *    We take only `name`, `recipeYield` and `recipeIngredient` from it – short strings, cleaned and capped.
 * 2. Otherwise the visible text of the page (scripts, styles, hidden elements and comments removed),
 *    preferring an element that looks like an ingredient list; capped in size.
 *
 * Everything here is untrusted text from a stranger's page. It is only ever: shown to you (escaped),
 * handed to the model as data (see recipe-ai.ts), or used as a URL-encoded search term. Never code, never a URL.
 */
import { parseHTML } from "linkedom";

export const MAX_LINES = 60;
export const MAX_LINE_CHARS = 200;
export const MAX_PAGE_CHARS = 8000;

export type RecipeSource = {
  /** "structured" = the site's own JSON-LD ingredient list; "page" = visible page text */
  kind: "structured" | "page";
  title: string | null;
  servings: number | null;
  /** ingredient lines (structured) or visible text lines (page), cleaned, capped */
  lines: string[];
  /** instruction-like text found anywhere on the page – shown to you as a warning, never acted on */
  suspicious: string[];
};

/** Collapse whitespace, drop control/invisible characters, strip any tags, cap the length. */
export function cleanLine(s: unknown, max = MAX_LINE_CHARS): string {
  if (typeof s !== "string" && typeof s !== "number") return "";
  // cap first: everything below is at least linear in the length, and the tag strip isn't
  let t = String(s).slice(0, max * 4);
  if (/[<&]/.test(t)) {
    // JSON-LD strings sometimes carry HTML (<b>, &amp;) – keep only the text
    const { document } = parseHTML(`<!doctype html><html><body><div>${t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")}</div></body></html>`);
    t = document.querySelector("div")?.textContent ?? "";
  }
  t = t
    .normalize("NFC")
    // zero-width / bidi controls are a classic way to hide text
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Phrases that address an AI rather than a cook. Only used to warn you. */
const SUSPICIOUS = [
  /ignore (all |any |the )?(previous|prior|above|earlier|your) (instructions|prompts?|rules)/i,
  /disregard (all |the )?(previous|prior|above|your)/i,
  /(system|developer) (prompt|message|instructions)/i,
  /you are (now )?(an?|the) (ai|assistant|agent|language model|llm)/i,
  /\b(as an ai|ai assistant|language model|llm|chatgpt|claude|anthropic|openai)\b/i,
  /\b(add|put) .{0,40}\b(to|in|into) (the |my |your )?(cart|basket|košarico)\b/i,
  /\b(place|confirm|submit) (the |an |my )?order\b/i,
  /\b(tool[_ ]?(use|call)|function call|<\/?(tool|system|assistant|untrusted)\b)/i, // no [^>]* tail: it backtracked quadratically
  /\b(api[_ -]?keys?|access tokens?|session cookies?|credit card numbers?)\b/i,
  /(prezri|ignoriraj|pozabi) (\S+ ){0,2}(navodila|ukaze|pravila)/i,
];

/** Instruction-like snippets, at most one per kind of phrase, so the same note isn't reported twice. */
export function findSuspicious(...texts: string[]): string[] {
  const hits: string[] = [];
  for (const re of SUSPICIOUS) {
    for (const text of texts) {
      const m = text.match(re);
      if (!m) continue;
      const at = m.index ?? 0;
      hits.push(cleanLine(text.slice(Math.max(0, at - 30), at + m[0].length + 30), 120));
      break;
    }
    if (hits.length >= 5) break;
  }
  return hits;
}

const typeIs = (node: any, type: string) => {
  const t = node?.["@type"];
  return t === type || (Array.isArray(t) && t.includes(type)) || (typeof t === "string" && t.endsWith(`/${type}`));
};

/** Find a Recipe object anywhere in parsed JSON-LD (@graph, arrays, nested), without unbounded recursion. */
function findRecipe(node: any, depth = 0): any | null {
  if (!node || typeof node !== "object" || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const n of node.slice(0, 200)) {
      const r = findRecipe(n, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (typeIs(node, "Recipe")) return node;
  for (const key of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement", "item"]) {
    const r = findRecipe(node[key], depth + 1);
    if (r) return r;
  }
  return null;
}

/** "4", "4 servings", "Za 4 osebe", ["4", "4 porcije"] → 4 (1–50), else null. */
export function parseServings(y: unknown): number | null {
  const vals = Array.isArray(y) ? y : [y];
  for (const v of vals) {
    const m = String(v ?? "").match(/\d+/);
    const n = m ? Number(m[0]) : NaN;
    if (Number.isInteger(n) && n >= 1 && n <= 50) return n;
  }
  return null;
}

function structured(document: any): Omit<RecipeSource, "suspicious"> | null {
  for (const s of [...document.querySelectorAll('script[type="application/ld+json"]')].slice(0, 20)) {
    const raw = String(s.textContent ?? "");
    if (raw.length > 500_000) continue;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      continue;
    }
    const recipe = findRecipe(json);
    if (!recipe) continue;
    const all = Array.isArray(recipe.recipeIngredient)
      ? recipe.recipeIngredient
      : Array.isArray(recipe.ingredients)
        ? recipe.ingredients
        : typeof recipe.recipeIngredient === "string"
          ? recipe.recipeIngredient.split(/\n|;/)
          : [];
    const ingredients = all.slice(0, MAX_LINES * 2);
    const lines = ingredients.map((l: unknown) => cleanLine(l)).filter(Boolean).slice(0, MAX_LINES);
    if (!lines.length) continue;
    return { kind: "structured", title: cleanLine(recipe.name, 120) || null, servings: parseServings(recipe.recipeYield ?? recipe.yield), lines };
  }
  return null;
}

/** Elements a reader never sees – a hiding place for text meant only for an AI. */
const HIDDEN =
  "script,style,noscript,template,svg,iframe,object,embed,canvas,head,form,button,input,select,textarea," +
  "[hidden],[aria-hidden=true],[style*='display:none'],[style*='display: none'],[style*='visibility:hidden']," +
  "[style*='visibility: hidden'],[style*='font-size:0'],[style*='font-size: 0'],[style*='opacity:0'],[style*='opacity: 0']," +
  ".sr-only,.visually-hidden,.screen-reader-text";

function visibleText(document: any): Omit<RecipeSource, "suspicious"> {
  for (const el of [...document.querySelectorAll(HIDDEN)]) el.remove();
  const title = cleanLine(document.querySelector("h1")?.textContent ?? document.querySelector("title")?.textContent ?? "", 120) || null;
  // an element that looks like the ingredient list, else the article / main content, else the body
  // nested candidates make textContent quadratic: look at the first few only, and measure each once
  const candidates = [...document.querySelectorAll("[class*=ingredient i],[id*=ingredient i],[class*=sestavin i],[id*=sestavin i]")].slice(0, 20);
  const sized = candidates.map((el: any) => ({ el, len: String(el.textContent ?? "").length }));
  const best = sized.sort((a, b) => b.len - a.len)[0]?.el;
  const root = best ?? document.querySelector("article") ?? document.querySelector("main") ?? (document.documentElement ? document.body : null);
  for (const br of [...(root?.querySelectorAll?.("br") ?? [])]) br.replaceWith("\n");
  for (const el of [...(root?.querySelectorAll?.("p,li,div,tr,h1,h2,h3,h4,dt,dd") ?? [])]) el.append("\n");
  const text = String(root?.textContent ?? "").slice(0, MAX_PAGE_CHARS * 2);
  const lines: string[] = [];
  let size = 0;
  for (const l of text.split("\n")) {
    const c = cleanLine(l);
    if (!c) continue;
    if (size + c.length > MAX_PAGE_CHARS || lines.length >= 150) break;
    lines.push(c);
    size += c.length;
  }
  return { kind: "page", title, servings: null, lines };
}

/** Where text meant only for an AI tends to hide: hidden elements, templates, the JSON-LD itself. */
const HIDING_PLACES =
  'script[type="application/ld+json"],noscript,template,[hidden],[aria-hidden=true],[style*="display:none"],[style*="display: none"],' +
  '[style*="visibility:hidden"],[style*="visibility: hidden"],[style*="font-size:0"],[style*="font-size: 0"],[style*="opacity:0"],' +
  '[style*="opacity: 0"],.sr-only,.visually-hidden,.screen-reader-text';

/**
 * Text of matched elements up to `max` characters. Stops early: with nested matches, each element's textContent
 * repeats its descendants', so collecting all of them first grows with the square of the nesting depth.
 */
function collectText(els: Iterable<any>, max: number): string {
  let out = "";
  let n = 0;
  for (const el of els) {
    if (out.length >= max || ++n > 2000) break;
    out += `${String(el.textContent ?? "").slice(0, max - out.length)}\n`;
  }
  return out;
}

export const MAX_NESTING = 5000;
const VOID = new Set("area base br col embed hr img input link meta param source track wbr".split(" "));
/** Elements the parser closes by itself when the next one starts – they never nest deeply. */
const SELF_CLOSING = new Set("p li dt dd tr td th option optgroup thead tbody tfoot rb rt rp".split(" "));
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "noscript", "template", "xmp", "iframe"]);

/**
 * Upper estimate of how deeply elements nest, in one linear pass (indexOf only – no regex that could backtrack).
 * linkedom's parser slows down sharply with depth (80k nested <div>s ≈ 4 s), and a page author controls depth.
 */
export function nestingDepth(html: string): number {
  const lower = html.toLowerCase(); // once – lowercasing per tag would be quadratic
  let depth = 0;
  let max = 0;
  let i = 0;
  while ((i = html.indexOf("<", i)) >= 0) {
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    const close = html[i + 1] === "/";
    let j = i + (close ? 2 : 1);
    let name = "";
    while (j < html.length && name.length < 20 && /[A-Za-z0-9-]/.test(html[j])) name += html[j++];
    name = name.toLowerCase();
    const gt = html.indexOf(">", j);
    if (!name || gt < 0) {
      i += 1;
      continue;
    }
    if (close) {
      if (!VOID.has(name) && !SELF_CLOSING.has(name)) depth = Math.max(0, depth - 1);
    } else if (RAW_TEXT.has(name)) {
      const end = lower.indexOf(`</${name}`, gt);
      i = end < 0 ? html.length : end;
      continue;
    } else if (!VOID.has(name) && !SELF_CLOSING.has(name) && html[gt - 1] !== "/") {
      max = Math.max(max, ++depth);
    }
    i = gt + 1;
  }
  return max;
}

/** Read a recipe out of a page's HTML. The page is parsed, never executed. */
export function extractRecipe(html: string): RecipeSource {
  const depth = nestingDepth(html);
  if (depth > MAX_NESTING) throw new Error(`that page's HTML is nested ${depth} levels deep – not a normal web page, not reading it`);
  // a page without <html>…</html> still parses as a document
  const { document } = parseHTML(/<html[\s>]/i.test(html.slice(0, 5000)) ? html : `<!doctype html><html><body>${html}</body></html>`);
  const hidden = collectText(document.querySelectorAll(HIDING_PLACES), 200_000);
  const found = structured(document) ?? visibleText(document);
  // warn about AI-directed text in what we'll use, and in places a reader never sees
  return { ...found, suspicious: findSuspicious(found.lines.join("\n"), hidden) };
}
