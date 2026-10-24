/**
 * Pick a replacement for a product you usually buy: heuristic ranking (similarity.ts), then – if ANTHROPIC_API_KEY
 * is set – Claude double-checks the shortlist and may say "none of these".
 */
import Anthropic from "@anthropic-ai/sdk";
import { categoryTail, rankSimilar, type Reference, type Scored } from "./similarity.ts";
import type { Product } from "../shop/products.ts";

export type Choice = { product: Product | null; reason: string; ranked: Scored[] };

let client: Anthropic | null = null;
const llm = () => (process.env.ANTHROPIC_API_KEY ? (client ??= new Anthropic()) : null);
const money = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "?" : n.toFixed(2));

export async function chooseSubstitute(ref: Reference, candidates: Product[], { useLlm = true, top = 8 } = {}): Promise<Choice> {
  const cat = categoryTail(ref.category);
  const sameCat = cat ? candidates.filter((c) => categoryTail(c.category) === cat) : [];
  const ranked = rankSimilar(ref, sameCat.length >= 3 ? sameCat : candidates);
  if (!ranked.length) return { product: null, reason: "no candidates", ranked };
  const fallback = { product: ranked[0].product, reason: ranked[0].reasons.join("; "), ranked };
  const ai = useLlm ? llm() : null;
  if (!ai) return fallback;

  const shortlist = ranked.slice(0, top);
  const row = (p: Reference | Product, notes = "") =>
    `${p.id ?? "-"} | ${p.name} | ${money(p.price)} € | ${money(p.unitPrice)} €/${p.unitBase ?? "?"} | ${p.brand ?? ""} | ${p.category ?? ""}${notes ? ` | ${notes}` : ""}`;
  const prompt = [
    "A shopper's usual grocery product is no longer sold. Pick the replacement they'd accept: the SAME kind of product and variant",
    "(e.g. wet vs dry toilet paper; skyr vs greek vs natural yoghurt; fresh vs long-life milk; flavour; lactose-free; bio),",
    "the same fat/alcohol %, the same ply, a similar quality tier (brand, price per unit) and pack size. Never prefer something just because it's cheaper.",
    "",
    `Usual product: ${row(ref)}`,
    "Candidates (id | name | price | unit price | brand | category | notes):",
    ...shortlist.map((s) => row(s.product, s.reasons.join("; "))),
    "",
    "Call the choose tool with your answer.",
  ].join("\n");
  try {
    // a forced tool call: the answer always comes back as structured input, never as prose to dig JSON out of
    const msg = await ai.messages.create({
      model: process.env.ANTHROPIC_MODEL ?? "claude-haiku-5-5",
      max_tokens: 400,
      tools: [
        {
          name: "choose",
          description: "Report the chosen replacement, or null if none of the candidates is a reasonable replacement.",
          input_schema: {
            type: "object",
            properties: {
              id: { type: ["string", "null"], description: "id of the chosen candidate, exactly as listed, or null" },
              reason: { type: "string", description: "one short sentence" },
            },
            required: ["id", "reason"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "choose" },
      messages: [{ role: "user", content: prompt }],
    });
    const call = msg.content.find((b) => b.type === "tool_use");
    if (!call || call.type !== "tool_use") throw new Error(`no tool call in the answer (stop reason: ${msg.stop_reason})`);
    const answer = call.input as { id?: string | null; reason?: string };
    const reason = answer.reason ?? "";
    if (answer.id == null) return { product: null, reason: reason || "none of the candidates fits", ranked };
    const hit = shortlist.find((s) => s.product.id === String(answer.id));
    if (hit) return { product: hit.product, reason, ranked };
    throw new Error(`answered with an id that isn't on the shortlist (${answer.id})`);
  } catch (err) {
    console.log(`   (AI check failed, using heuristic: ${err instanceof Error ? err.message : err})`);
  }
  return fallback;
}
