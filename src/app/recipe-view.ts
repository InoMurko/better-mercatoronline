/** A recipe plan as a Telegram message: one tap per line toggles "buy" / "at home". All page text is escaped. */
import { InlineKeyboard } from "grammy";
import { shortName } from "./basket.ts";
import { esc, eur } from "./basket-view.ts";
import { priceLine } from "./offers.ts";
import type { RecipePlan } from "./recipe-match.ts";

// 8 lines × (product, price, note, original ≤ 120 chars) keeps one page well under Telegram's 4096 characters
export const RECIPE_PAGE = 8;

export const recipeTotal = (plan: RecipePlan) =>
  plan.lines.filter((l) => l.include && l.product).reduce((s, l) => s + priceLine(l.product!, l.qty).final, 0);

export function renderRecipe(plan: RecipePlan & { suspicious?: string[] }, id: string, page = 0) {
  const pages = Math.max(1, Math.ceil(plan.lines.length / RECIPE_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const from = p * RECIPE_PAGE;
  const shown = plan.lines.slice(from, from + RECIPE_PAGE);
  const buying = plan.lines.filter((l) => l.include && l.product).length;

  const head = [
    `🍳 <b>${esc(plan.title ?? "Recipe")}</b>${plan.servings ? ` – ${plan.servings} servings` : ""}`,
    `<i>Tap a product to switch between 🛒 buy and 🏠 at home. Nothing goes in the cart until you add it to the basket and confirm there.</i>`,
  ];
  if (plan.suspicious?.length)
    head.push(`⚠️ <b>This page contains text aimed at an AI</b> (e.g. “${esc(plan.suspicious[0])}”). It was treated as plain text – check the list carefully.`);
  const body = shown.map((l) => {
    const orig = `   <i>“${esc(l.original.length > 120 ? `${l.original.slice(0, 119)}…` : l.original)}”</i>`;
    if (!l.product) return `✗ ${esc(l.ingredient.search)} – ${esc(l.why)}\n${orig}`;
    const price = eur(priceLine(l.product, l.qty).final);
    const mark = l.include ? "🛒" : "🏠";
    const why = !l.include || l.why ? ` – <i>${esc(l.why || "at home")}</i>` : "";
    return `${mark} ${l.qty} × ${esc(l.product.name)} – ${price}${why}${l.flag ? `\n   ⚠️ ${esc(l.flag)}` : ""}\n${orig}`;
  });
  const foot = `\n<b>${buying} to buy – ${eur(recipeTotal(plan))}</b>${pages > 1 ? ` · page ${p + 1}/${pages}` : ""}`;

  const kb = new InlineKeyboard();
  shown.forEach((l, k) => {
    if (!l.product) return;
    kb.text(`${l.include ? "🛒" : "🏠"} ${l.qty}× ${shortName(l.product.name, l.product.brand, 30)}`, `rc:t:${id}:${from + k}:${p}`).row();
  });
  if (pages > 1) {
    if (p > 0) kb.text("◀", `rc:p:${id}:${p - 1}`);
    kb.text(`${p + 1}/${pages}`, `rc:n:${id}:${p}`);
    if (p < pages - 1) kb.text("▶", `rc:p:${id}:${p + 1}`);
    kb.row();
  }
  if (plan.servings) kb.text("➖ serving", `rc:s:${id}:-1:${p}`).text(`${plan.servings} servings`, `rc:n:${id}:${p}`).text("➕ serving", `rc:s:${id}:1:${p}`).row();
  kb.text(`🧺 Add ${buying} to basket`, `rc:go:${id}`).text("❌ Discard", `rc:x:${id}`);
  return { text: [...head, "", ...body, foot].join("\n"), kb };
}
