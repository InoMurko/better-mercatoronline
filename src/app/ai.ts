/** The Anthropic client for the recipe feature. Recipes are AI-first: no key, no recipes (everything else works without one). */
import Anthropic from "@anthropic-ai/sdk";

/** Just the part we use – so tests can pass a fake. */
export type Ai = Pick<Anthropic, "messages">;

let client: Anthropic | null = null;
export function recipeAi(): Ai {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("Recipes need ANTHROPIC_API_KEY – the AI reads the recipe and picks the products.");
  return (client ??= new Anthropic());
}
export const model = () => process.env.ANTHROPIC_MODEL ?? "claude-haiku-5-5";
