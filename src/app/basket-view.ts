/** How the basket looks in Telegram: one page of products with ➖ ➕ 🗑, the whole basket's total. */
import { InlineKeyboard } from "grammy";
import { regularTotal, shortName, total, type Basket } from "./basket.ts";
import { priceLine } from "./offers.ts";

const FREE_DELIVERY = Number(process.env.FREE_DELIVERY_EUR ?? 60); // Mercator: free delivery from 60 €; 0 hides the hint
export const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
export const eur = (n: number) => `${n.toFixed(2).replace(".", ",")} €`;

export const PAGE_SIZE = 8; // 8 products × 5 buttons + navigation fits Telegram's 100 buttons; text stays well under 4096 chars

/** One page of the basket: its products in full, the whole basket's total, and buttons for this page. */
export function renderBasket(b: Basket, page = 0) {
  const pages = Math.max(1, Math.ceil(b.items.length / PAGE_SIZE));
  page = Math.min(Math.max(0, page), pages - 1);
  const from = page * PAGE_SIZE;
  const shown = b.items.slice(from, from + PAGE_SIZE);

  const lines = [`🧺 <b>Shopping basket</b> – ${b.items.length} products, not in your cart yet${pages > 1 ? ` · page ${page + 1}/${pages}` : ""}`, ""];
  shown.forEach((i, k) => {
    const n = from + k;
    const pl = priceLine(i.product, i.qty);
    const was = pl.regular > pl.final + 0.004 ? ` <s>${eur(pl.regular)}</s>` : "";
    lines.push(`${n + 1}. <b>${i.qty}×</b> ${esc(i.product.name)} – <b>${eur(pl.final)}</b>${was}`);
    if (pl.notes.length) lines.push(`    🏷 ${esc(pl.notes.join(" · "))}`);
    if (i.why) lines.push(`    <i>${esc(i.why)}</i>`);
    if (i.note && !["your usual", "your choice"].includes(i.note)) lines.push(`    <i>${esc(i.note.slice(0, 160))}</i>`);
  });
  if (!b.items.length) lines.push("<i>(empty)</i>");
  const t = total(b);
  const saved = regularTotal(b) - t;
  const delivery = FREE_DELIVERY > 0 ? (t >= FREE_DELIVERY ? " · free delivery ✓" : ` · ${eur(FREE_DELIVERY - t)} more for free delivery`) : "";
  lines.push(
    "",
    `<b>Total ${eur(t)}</b> with discounts${saved >= 0.01 ? ` – you save ${eur(saved)}` : ""}${delivery}`,
    "<i>Prices include sale and Pika discounts; Mercator's cart shows the exact total after “Put in cart”.</i>",
    "",
    "➖ ➕ change amounts · 🗑 removes · send a product name to add something",
  );

  const kb = new InlineKeyboard();
  // phone-friendly: the name gets a full-width row, the controls the row below it
  shown.forEach((i, k) => {
    const n = from + k;
    kb.text(`${n + 1}. ${shortName(i.product.name, i.product.brand)}`, `bk:nop:${n}:${b.id}:${page}`)
      .row()
      .text("➖", `bk:dec:${n}:${b.id}:${page}`)
      .text(`${i.qty}× · ${eur(priceLine(i.product, i.qty).final)}`, `bk:price:${n}:${b.id}:${page}`)
      .text("➕", `bk:inc:${n}:${b.id}:${page}`)
      .text("🗑", `bk:del:${n}:${b.id}:${page}`)
      .row();
  });
  if (pages > 1) {
    kb.text(page > 0 ? "◀ Previous" : " ", `bk:pg:${page - 1}:${b.id}:${page}`)
      .text(`${page + 1} / ${pages}`, `bk:nop:-1:${b.id}:${page}`)
      .text(page < pages - 1 ? "Next ▶" : " ", `bk:pg:${page + 1}:${b.id}:${page}`)
      .row();
  }
  if (b.items.length) kb.text(`✅ Put all ${b.items.length} in cart (${eur(t)})`, `bk:go:0:${b.id}:${page}`).row();
  kb.text("❌ Discard", `bk:x:0:${b.id}:${page}`);

  let text = lines.join("\n");
  if (text.length > 4000) text = lines.filter((l) => !l.startsWith("    <i>")).join("\n"); // drop the reasons if still too long
  return { text, kb };
}

