/**
 * Talk to your shopping agent on Telegram.
 *
 *   npm run bot
 *
 * Setup (once): create a bot with @BotFather → put TELEGRAM_BOT_TOKEN in .env → run `npm run bot` →
 * send /start to your bot → it replies with your chat id → put TELEGRAM_CHAT_ID in .env → restart.
 * Only that chat can use the bot; everyone else is ignored.
 *
 * Nothing changes your cart without you pressing a button, and an order is only placed after your ✅ on its review.
 */
import { Bot, InlineKeyboard, type Context } from "grammy";
import { Http } from "./core/http.ts";
import { randomUUID } from "node:crypto";
import { requireEnv, ShopSession } from "./app/session.ts";
import { add, clearCart, readCart } from "./shop/cart.ts";
import { importNewOrders } from "./shop/orders.ts";
import { loadHistory, pendingLookups, rebuildHistory } from "./app/history.ts";
import { fmtProduct, planPick } from "./app/picking.ts";
import { addItems, buildBasket, defaultHorizon, describeHabit, loadHabits, type CartItem } from "./app/restock.ts";
import { addItem, changeQty, loadBasket, removeItem, saveBasket, type Basket } from "./app/basket.ts";
import { priceLine } from "./app/offers.ts";
import { renderBasket } from "./app/basket-view.ts";
import { confirmOrder, openDelivery, PAYMENT_METHODS, paymentMethod, prepareOrder, type DeliveryStep, type Review, type Slot } from "./shop/checkout.ts";
import { cartLock } from "./shop/cart.ts";
import { recipeFromUrl, rescale, toCartItems, type RecipePlan } from "./app/recipe-match.ts";
import { renderRecipe } from "./app/recipe-view.ts";

// files the agent creates (orders, history, basket, session) are readable by you only
process.umask(0o077);

const bot = new Bot(requireEnv("TELEGRAM_BOT_TOKEN"));
const OWNER = process.env.TELEGRAM_CHAT_ID ? Number(process.env.TELEGRAM_CHAT_ID) : null;
const DAILY_AT = process.env.DAILY_CHECK_AT ?? "09:00"; // local time, "off" to disable
const shop = new ShopSession();
/** step 2 of the checkout in progress (slots + the page they came from) */
let deliveryStep: DeliveryStep | null = null;
const FREE_DELIVERY = Number(process.env.FREE_DELIVERY_EUR ?? 60); // Mercator: free delivery from 60 €; 0 hides the hint

// ---------- helpers ----------

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
const eur = (n: number) => `${n.toFixed(2).replace(".", ",")} €`;

async function send(chatId: number, html: string, keyboard?: InlineKeyboard) {
  // Telegram caps messages at 4096 characters
  const chunks = html.match(/[\s\S]{1,3800}(\n|$)/g) ?? [html];
  for (const [i, chunk] of chunks.entries()) {
    await bot.api.sendMessage(chatId, chunk, {
      parse_mode: "HTML",
      reply_markup: i === chunks.length - 1 ? keyboard : undefined,
      link_preview_options: { is_disabled: true },
    });
  }
}

/** Actions waiting for a button press. */
type Pending =
  | { kind: "add"; items: CartItem[] }
  | { kind: "clear" }
  | { kind: "like"; names: string[] }
  | { kind: "tobasket"; item: CartItem }
  | { kind: "slots"; slots: Slot[] }
  | { kind: "order"; slot: Slot; review: Review };
const pending = new Map<string, Pending & { at: number }>();
function remember(p: Pending): string {
  for (const [id, v] of pending) if (Date.now() - v.at > 24 * 3600_000) pending.delete(id);
  const id = randomUUID().slice(0, 8);
  pending.set(id, { ...p, at: Date.now() });
  return id;
}

const confirmButtons = (id: string, yes = "✅ Add to cart") => new InlineKeyboard().text(yes, `ok:${id}`).text("❌ Skip", `no:${id}`);

/** Run a shop task, telling the user what's happening. Cart/checkout tasks queue behind each other (cartLock). */
async function work<T>(ctx: Context, what: string, task: (http: Http) => Promise<T>, opts: { loggedIn?: boolean } = {}) {
  await ctx.reply(cartLock.busy ? `⏳ ${what} – after the current cart task…` : `⏳ ${what}…`);
  await ctx.replyWithChatAction("typing");
  try {
    const http = opts.loggedIn === false ? shop.anon : await shop.loggedIn();
    return await task(http);
  } catch (err) {
    console.error(`${what} failed:`, err);
    await ctx.reply(`⚠️ ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

// ---------- access control ----------

bot.use(async (ctx, next) => {
  const chatId = ctx.chat?.id;
  if (OWNER == null) {
    if (ctx.message?.text?.startsWith("/start") && chatId) {
      console.log(`→ /start from chat ${chatId} (@${ctx.from?.username ?? "?"}). Put TELEGRAM_CHAT_ID=${chatId} in .env and restart.`);
      await ctx.reply(`Your chat id is ${chatId}.\nPut TELEGRAM_CHAT_ID=${chatId} in the agent's .env and restart it – until then I won't do anything.`);
    }
    return;
  }
  if (chatId !== OWNER) {
    console.log(`ignored message from chat ${chatId} (@${ctx.from?.username ?? "?"})`);
    return;
  }
  await next();
});

// ---------- commands ----------

/** Every command, once: used for the help text and for Telegram's command menu. */
const COMMANDS = [
  { command: "shop", description: "Build the basket I think you need – edit it, then put it in the cart" },
  { command: "due", description: "What you'll probably run out of soon, and why I think so" },
  { command: "basket", description: "Show the basket you're editing" },
  { command: "cart", description: "What's in your Mercator cart" },
  { command: "checkout", description: "Pick a delivery slot and place the order (pay on delivery)" },
  { command: "clear", description: "Empty the Mercator cart (asks first)" },
  { command: "import", description: "Fetch new orders from your account" },
  { command: "recipe", description: "Send a recipe link – I'll turn it into a shopping list" },
  { command: "help", description: "This list" },
];

const HELP = () =>
  [
    "<b>Your shopping agent</b>",
    ...COMMANDS.map((c) => `/${c.command} – ${esc(c.description)}`),
    "",
    "Or just send a product, e.g. <i>toaletni papir</i> – I'll find the one you usually buy.",
    "Or send a recipe link (English or Slovenian) – I'll list the products; you untick what you have at home.",
    "Send <i>help</i> any time for this list.",
    "",
    "<b>How I know what you need</b>",
    "From your orders I learn how often you buy each kind of product and how much (e.g. ~10 rolls of toilet paper every ~30 days). " +
      `From your last purchase I estimate what's left. <b>Due</b> = likely to run out within ${defaultHorizon()} days; ` +
      "<b>soon</b> = the week after – /shop includes those too, so one delivery covers both.",
    "",
    `I only fill the cart – you check out yourself. Daily check: ${DAILY_AT === "off" ? "off" : DAILY_AT}.`,
  ].join("\n");

/** Plain-text messages that mean "help", not a product search. */
const HELP_WORDS = /^(help|pomoč|pomoc|ukazi|commands|menu|\?)$/i;

bot.command(["start", "help"], (ctx) => ctx.reply(HELP(), { parse_mode: "HTML" }));

const ddmm = (iso: string) => `${Number(iso.slice(8, 10))}. ${Number(iso.slice(5, 7))}.`;
const shopButton = () => new InlineKeyboard().text("🧺 Build a basket from this", "shop");

async function dueReport(chatId: number, { quietIfNothing = false } = {}) {
  const all = await loadHabits(shop.anon, { historyLookups: 0 });
  const due = all.filter((h) => h.status === "due");
  const soon = all.filter((h) => h.status === "soon");
  if (!due.length && quietIfNothing) return;

  const first = loadHistory().flatMap((e) => e.purchases.map((p) => p.date)).sort()[0];
  const lines = [
    `<i>From your ${first ? `orders since ${ddmm(first)}${first.slice(0, 4)}` : "orders"} I know how often you buy each kind of product and how much, ` +
      `so I can estimate what's left at home. Due = likely gone within ${defaultHorizon()} days.</i>`,
    "",
  ];
  const item = (h: (typeof all)[number]) => {
    const [, how] = describeHabit(h);
    return `• <b>${esc(h.usual.name)}</b>\n   <i>${esc(how.replace(/last (\d{4}-\d{2}-\d{2})/, (_, d: string) => `last ${ddmm(d)}`))}</i>`;
  };
  if (due.length) lines.push(`<b>Due</b> (${due.length}):`, ...due.map(item));
  else lines.push("Nothing is running low. 👍");
  if (soon.length) lines.push("", `<b>Soon</b> – within ${defaultHorizon() + 7} days (${soon.length}):`, ...soon.map(item));
  await send(chatId, lines.join("\n"), due.length || soon.length ? shopButton() : undefined);
}

bot.command(["due", "restock"], async (ctx) => {
  await ctx.reply("⏳ Checking what's running low…");
  try {
    await dueReport(ctx.chat.id);
  } catch (err) {
    await ctx.reply(`⚠️ ${err instanceof Error ? err.message : String(err)}`);
  }
});

// ---------- shopping basket ----------

let basket: Basket | null = loadBasket();

// ---------- checkout: slot → pay on delivery → review → your ✅ ----------

const checkoutButton = () => new InlineKeyboard().text("🚚 Choose delivery & check out", "co:start");
const hhmm = (t: string) => t.replace(/(\d{2}):00/g, "$1").replace(/\s*-\s*/, "–");

async function startCheckout(ctx: Context) {
  const step = await work<DeliveryStep>(ctx, "Opening checkout and reading delivery slots", async (http) => {
    paymentMethod(); // fail early on a bad PAYMENT_METHOD
    return openDelivery(http);
  });
  if (!step) return;
  deliveryStep = step;
  const slots = step.slots;
  if (!slots.length) return ctx.reply("No free delivery slots in the next days. Try again later.");
  const id = remember({ kind: "slots", slots });
  const kb = new InlineKeyboard();
  const days = [...new Set(slots.map((x) => x.day))];
  for (const day of days) {
    kb.text(`📅 ${day}`, `co:nop:${id}`).row();
    slots.forEach((x, i) => {
      if (x.day !== day) return;
      kb.text(`${hhmm(x.time)}${x.price != null ? ` · ${x.price ? eur(x.price) : "free"}` : ""}`, `co:slot:${id}:${i}`);
      if (slots.filter((y, j) => y.day === day && j <= i).length % 3 === 0) kb.row();
    });
    kb.row();
  }
  kb.text("❌ Not now", `co:no:${id}`);
  await ctx.reply(
    `🚚 <b>Pick a delivery slot</b> (price = delivery fee for this cart; free over ${eur(FREE_DELIVERY)}).\nPayment: <b>${PAYMENT_METHODS[paymentMethod()]}</b>.`,
    { parse_mode: "HTML", reply_markup: kb },
  );
}

function reviewText(r: Review) {
  return [
    `🧾 <b>Ready to order</b>${r.orderNo ? ` (Mercator #${r.orderNo})` : ""}`,
    `• ${r.items || "?"} products – ${r.productsValue != null ? eur(r.productsValue) : "?"}`,
    `• Delivery: ${esc(r.when)}${r.delivery != null ? ` – ${r.delivery ? eur(r.delivery) : "free"}` : ""}`,
    `• Payment: ${esc(r.payment)}`,
    `<b>Total ${eur(r.total)}</b> – paid at the door; the bill only counts what's actually delivered.`,
    "",
    "<i>✅ places the order and accepts Mercator's terms of business (Pogoji poslovanja).</i>",
  ].join("\n");
}

async function prepareAndShow(ctx: Context, slot: Slot) {
  const review = await work<Review>(ctx, `Booking ${slot.day} ${hhmm(slot.time)}`, async (http) => {
    const step = deliveryStep ?? (await openDelivery(http));
    return (await prepareOrder(http, step, slot, paymentMethod())).review;
  });
  if (!review) return;
  const id = remember({ kind: "order", slot, review });
  await ctx.reply(reviewText(review), {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard()
      .text(`✅ Place order (${eur(review.total)})`, `co:go:${id}`)
      .row()
      .text("↩ Other slot", "co:start")
      .text("❌ Not now", `co:no:${id}`),
  });
}

async function placeOrder(ctx: Context, p: { slot: Slot; review: Review }) {
  const res = await work<{ orderNo: string | null; message: string }>(ctx, "Placing the order", (http) =>
    // confirmOrder re-reads the review page and refuses unless it matches what you approved
    confirmOrder(http, p.review, process.env.DELIVERY_NOTE || undefined),
  );
  if (!res) return ctx.reply("Nothing was ordered. /checkout to try again.");
  await ctx.reply(
    `🎉 <b>Order placed</b>${res.orderNo ? ` – #${res.orderNo}` : ""}\nDelivery ${esc(p.review.when)}, ${eur(p.review.total)} ${PAYMENT_METHODS[paymentMethod()]}.\n<i>${esc(res.message)}</i>`,
    { parse_mode: "HTML" },
  );
  // pull the new order into your history in a while
  setTimeout(() => void shop.loggedIn().then((http) => importNewOrders(http, { log: () => undefined })).then(() => refreshInBackground()).catch(() => undefined), 10 * 60_000);
}

bot.command("checkout", (ctx) => startCheckout(ctx));

/** The real cart as Mercator shows it: its own line totals (after all discounts) and their sum. */
function cartText(cart: { name: string; quantity: number; lineTotal?: number | null }[]) {
  if (!cart.length) return "(empty)";
  const lines = cart.map((l) => `• ${l.quantity} × ${esc(l.name)}${l.lineTotal != null ? ` – ${eur(l.lineTotal)}` : ""}`);
  const known = cart.filter((l) => l.lineTotal != null);
  if (known.length === cart.length) lines.push(`<b>Total ${eur(known.reduce((s, l) => s + l.lineTotal!, 0))}</b> (Mercator's prices, all discounts applied)`);
  return lines.join("\n");
}

async function showBasket(chatId: number, page = 0) {
  if (!basket) return send(chatId, "No basket open – /shop builds one.");
  const { text, kb } = renderBasket(basket, page);
  await bot.api.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } });
}

async function startShopping(ctx: Context) {
  const res = await work<Awaited<ReturnType<typeof buildBasket>> & { inCart: string[] }>(ctx, "Building your basket from your habits", async (http) => {
    // plan the basket and read the cart at the same time
    const [built, cart] = await Promise.all([buildBasket(http, { historyLookups: 0 }), readCart(http).catch(() => [])]);
    // leave out what's already in your cart
    const norm = (x: string) => x.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
    const have = new Set(cart.map((l) => norm(l.name)));
    const inCart = built.items.filter((i) => have.has(norm(i.product.name))).map((i) => i.product.name);
    return { ...built, items: built.items.filter((i) => !have.has(norm(i.product.name))), inCart };
  });
  if (!res) return;
  if (res.inCart.length) await ctx.reply(`Already in your cart, left out: ${res.inCart.join(", ")}`);
  basket = { id: randomUUID().slice(0, 8), items: res.items };
  saveBasket(basket);
  const intro = res.items.length
    ? `${res.due.length} due, ${res.soon.length} soon – here's what I'd buy:`
    : "Nothing is running low – the basket is empty. Send product names to add things.";
  const warn = res.unavailable.map((n) => `⚠️ ${esc(n)} isn't sold any more and nothing similar fits.`);
  await send(ctx.chat!.id, [intro, ...warn].join("\n"));
  await showBasket(ctx.chat!.id);
}

bot.command("shop", (ctx) => startShopping(ctx));
bot.command("basket", (ctx) => showBasket(ctx.chat.id));

bot.command("cart", async (ctx) => {
  const items = await work<Awaited<ReturnType<typeof readCart>>>(ctx, "Reading the cart", (http) => readCart(http));
  if (!items) return;
  if (!items.length) return ctx.reply("The cart is empty.");
  await send(ctx.chat.id, `🛒 <b>Your Mercator cart</b>\n${cartText(items)}`, checkoutButton());
});

bot.command("clear", async (ctx) => {
  await ctx.reply("Empty the whole cart?", { reply_markup: confirmButtons(remember({ kind: "clear" }), "🗑 Empty it") });
});

bot.command("import", async (ctx) => {
  const r = await work<Awaited<ReturnType<typeof importNewOrders>>>(ctx, "Fetching new orders", (http) => importNewOrders(http));
  if (!r) return;
  if (r.added.length) void refreshInBackground();
  await send(
    ctx.chat.id,
    r.added.length ? `Imported ${r.added.length} new order(s):\n${r.added.map(esc).join("\n")}` : `No new orders (${r.found} in your account).` +
      (r.failed.length ? `\n⚠️ couldn't read: ${r.failed.map(esc).join(", ")}` : ""),
  );
});

// free text = "I need …"
async function pickFor(ctx: Context, query: string, like?: string) {
  const plan = await work<Awaited<ReturnType<typeof planPick>>>(ctx, like ? `Looking for ${like}` : `Looking for “${query}”`, (http) =>
    planPick(http, query, { like, historyLookups: 0 }),
    { loggedIn: false },
  );
  if (!plan) return;
  let text = plan.lines.map(esc).join("\n");
  if (plan.choice) {
    const item: CartItem = { product: plan.choice, qty: plan.qty, note: "your choice" };
    const pl = priceLine(plan.choice, plan.qty);
    const kb = basket
      ? new InlineKeyboard()
          .text(`🧺 Add ${plan.qty} × to basket`, `ok:${remember({ kind: "tobasket", item })}`)
          .text(`🛒 Straight to cart`, `ok:${remember({ kind: "add", items: [item] })}`)
      : confirmButtons(remember({ kind: "add", items: [item] }), `✅ Add ${plan.qty} × (${eur(pl.final)})`);
    const extra = [
      pl.regular > pl.final + 0.004 ? `${plan.qty} × now ${eur(pl.final)} instead of ${eur(pl.regular)}` : "",
      pl.notes.length ? `🏷 ${pl.notes.join(" · ")}` : "",
    ].filter(Boolean);
    if (extra.length) text += `\n${extra.map(esc).join("\n")}`;
    if (plan.alsoBought.length) {
      const id = remember({ kind: "like", names: plan.alsoBought });
      plan.alsoBought.forEach((n, i) => kb.row().text(`↔ ${n.slice(0, 40)}`, `like:${id}:${i}`));
    }
    return send(ctx.chat!.id, text, kb);
  }
  const opts = plan.options.map((p) => `• ${esc(fmtProduct(p))}`).join("\n");
  if (!plan.options.length) return send(ctx.chat!.id, text || "Nothing found.");
  const id = remember({ kind: "like", names: plan.options.map((p) => p.name) });
  const kb = new InlineKeyboard();
  plan.options.forEach((p, i) => kb.text(`${p.name.slice(0, 40)} – ${eur(p.price)}`, `like:${id}:${i}`).row());
  await send(ctx.chat!.id, `${text}\nWhich one?\n${opts}`, kb);
}

// ---------- recipes ----------

/** Recipe plans waiting for your taps (the last few only). */
const recipes = new Map<string, RecipePlan & { suspicious: string[] }>();
const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/i;

async function startRecipe(ctx: Context, url: string) {
  const plan = await work<Awaited<ReturnType<typeof recipeFromUrl>>>(
    ctx,
    "Reading the recipe and finding the products",
    async (http) => recipeFromUrl(http, url, { habits: await loadHabits(http, { historyLookups: 0 }).catch(() => []) }),
    { loggedIn: false },
  );
  if (!plan) return;
  const id = randomUUID().slice(0, 8);
  recipes.set(id, plan);
  while (recipes.size > 5) recipes.delete(recipes.keys().next().value!);
  const { text, kb } = renderRecipe(plan, id);
  await bot.api.sendMessage(ctx.chat!.id, text, { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } });
}

bot.command("recipe", async (ctx) => {
  const url = ctx.match.match(URL_IN_TEXT)?.[0];
  if (!url) return ctx.reply("Send /recipe followed by a link, or just paste the link.");
  return startRecipe(ctx, url);
});

bot.on("message:text", async (ctx) => {
  const q = ctx.message.text.trim();
  if (HELP_WORDS.test(q)) return ctx.reply(HELP(), { parse_mode: "HTML" });
  const link = q.match(URL_IN_TEXT)?.[0];
  if (link) return startRecipe(ctx, link);
  if (q.startsWith("/")) return ctx.reply(HELP(), { parse_mode: "HTML" }); // unknown command → show what exists
  await pickFor(ctx, q);
});

// ---------- buttons ----------

bot.on("callback_query:data", async (ctx, next) => {
  const data = ctx.callbackQuery.data;
  if (data === "shop") {
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    return startShopping(ctx);
  }
  if (data.startsWith("rc:")) {
    const [, op, rid, a, b] = data.split(":");
    const plan = recipes.get(rid);
    if (!plan) {
      await ctx.answerCallbackQuery({ text: "That recipe expired – send the link again." });
      return ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    }
    let page = Number(b ?? a) || 0;
    let next = plan;
    if (op === "n") return ctx.answerCallbackQuery();
    if (op === "t") {
      const i = Number(a);
      const line = plan.lines[i];
      if (!line?.product) return ctx.answerCallbackQuery();
      next = { ...plan, lines: plan.lines.map((l, k) => (k === i ? { ...l, include: !l.include } : l)) };
      await ctx.answerCallbackQuery({ text: `${next.lines[i].include ? "🛒 buy" : "🏠 at home"}: ${line.product.name.slice(0, 80)}` });
    } else if (op === "p") {
      page = Number(a) || 0;
      await ctx.answerCallbackQuery();
    } else if (op === "s") {
      next = { ...rescale(plan, (plan.servings ?? 1) + Number(a)), suspicious: plan.suspicious };
      await ctx.answerCallbackQuery({ text: `${next.servings} servings` });
    } else if (op === "x") {
      recipes.delete(rid);
      await ctx.answerCallbackQuery({ text: "Recipe discarded" });
      return ctx.editMessageText("🍳 Recipe discarded – nothing added.").catch(() => undefined);
    } else if (op === "go") {
      const items = toCartItems(plan);
      await ctx.answerCallbackQuery();
      if (!items.length) return ctx.reply("Everything is marked 🏠 at home – nothing to add.");
      recipes.delete(rid);
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
      basket ??= { id: randomUUID().slice(0, 8), items: [] };
      for (const it of items) basket = addItem(basket, it);
      saveBasket(basket);
      await ctx.reply(`🧺 Added ${items.length} products from the recipe to your basket. Check it, then ✅ puts it in the cart.`);
      return showBasket(ctx.chat!.id);
    } else return ctx.answerCallbackQuery();
    recipes.set(rid, next);
    const { text, kb } = renderRecipe(next, rid, page);
    return ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } }).catch(() => undefined);
  }
  if (data.startsWith("co:")) {
    const [, op, cid, idx] = data.split(":");
    await ctx.answerCallbackQuery();
    if (op === "start") {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
      return startCheckout(ctx);
    }
    const p = pending.get(cid);
    if (op === "nop") return;
    if (!p) return ctx.reply("That expired – /checkout to start again.");
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    if (op === "no") {
      pending.delete(cid);
      return ctx.reply("OK – nothing ordered. Your cart stays as it is.");
    }
    if (op === "slot" && p.kind === "slots") {
      const slot = p.slots[Number(idx)];
      if (slot) return prepareAndShow(ctx, slot);
    }
    if (op === "go" && p.kind === "order") {
      pending.delete(cid); // one tap = one order, even if you double-tap
      return placeOrder(ctx, p);
    }
    return;
  }
  if (!data.startsWith("bk:")) return next();

  const [, op, idx, id, pageStr] = data.split(":");
  const page = Number(pageStr) || 0;
  if (!basket || basket.id !== id) {
    await ctx.answerCallbackQuery({ text: "That basket is gone – /shop builds a new one." });
    return ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
  }
  const n = Number(idx);
  if (op === "nop") return ctx.answerCallbackQuery({ text: basket.items[n]?.product.name.slice(0, 190) ?? "" });
  if (op === "pg") {
    await ctx.answerCallbackQuery();
    return updateBasketMessage(ctx, n);
  }
  if (op === "price") {
    const i = basket.items[n];
    if (!i) return ctx.answerCallbackQuery();
    const pl = priceLine(i.product, i.qty);
    const unit = i.product.unitPrice != null ? ` · ${eur(i.product.unitPrice)}/${i.product.unitBase}` : "";
    const was = pl.regular > pl.final + 0.004 ? ` (regular ${eur(pl.regular)})` : "";
    const notes = pl.notes.length ? `\n${pl.notes.join(" · ")}` : "";
    return ctx.answerCallbackQuery({ text: `${i.qty} × ${eur(i.product.price)} → ${eur(pl.final)}${was}${unit}${notes}`.slice(0, 199), show_alert: pl.notes.length > 0 });
  }
  if (op === "x") {
    basket = null;
    saveBasket(null);
    await ctx.answerCallbackQuery({ text: "Basket discarded" });
    return ctx.editMessageText("🧺 Basket discarded – your cart wasn't touched.").catch(() => ctx.reply("🧺 Basket discarded – your cart wasn't touched."));
  }
  if (op === "go") {
    const b = basket;
    basket = null;
    saveBasket(null);
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    // progress in one message that updates itself every few products
    const status = await ctx.reply(`⏳ Putting ${b.items.length} products in your cart – 0/${b.items.length}`);
    let lastEdit = 0;
    const progress = (done: number, all: number) => {
      if (done !== all && Date.now() - lastEdit < 4_000) return;
      lastEdit = Date.now();
      void bot.api.editMessageText(status.chat.id, status.message_id, `⏳ Putting ${all} products in your cart – ${done}/${all}`).catch(() => undefined);
    };
    let r: Awaited<ReturnType<typeof addItems>> | undefined;
    try {
      r = await addItems(await shop.loggedIn(), b.items, progress);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("put in cart failed:", err);
      await ctx.reply(`⚠️ Couldn't start adding to the cart: ${msg}\nThe basket is kept – fix the problem and tap ✅ again.`);
    }
    if (!r) {
      basket = b; // keep it so you can try again
      saveBasket(b);
      return showBasket(ctx.chat!.id);
    }
    if (!r.added) {
      basket = b;
      saveBasket(b);
      await send(ctx.chat!.id, `⚠️ Nothing could be added:\n${r.problems.slice(0, 5).map(esc).join("\n")}\nThe basket is kept.`);
      return showBasket(ctx.chat!.id);
    }
    if (r.failed.length) {
      // keep what didn't make it, so ✅ tries just those again
      basket = { id: randomUUID().slice(0, 8), items: r.failed };
      saveBasket(basket);
    }
    await send(
      ctx.chat!.id,
      `🛒 <b>Your Mercator cart now</b> (${r.added} of ${b.items.length} added)\n${cartText(r.cart)}` +
        (r.problems.length ? `\n\n⚠️ Not added:\n${r.problems.map(esc).join("\n")}` : ""),
      checkoutButton(),
    );
    if (r.failed.length) {
      await ctx.reply(`The ${r.failed.length} that didn't make it are still in your basket – ✅ there tries them again.`);
      return showBasket(ctx.chat!.id);
    }
    return;
  }
  const name = basket.items[n]?.product.name ?? "";
  basket = op === "inc" ? changeQty(basket, n, +1) : op === "dec" ? changeQty(basket, n, -1) : op === "del" ? removeItem(basket, n) : basket;
  saveBasket(basket);
  const now = basket.items.find((i) => i.product.name === name)?.qty ?? 0;
  await ctx.answerCallbackQuery({ text: now ? `${now}× ${name.slice(0, 60)}` : `Removed ${name.slice(0, 60)}` });
  return updateBasketMessage(ctx, page);
});

/** Redraw the basket in the message that was tapped; if Telegram refuses, say why in the log and send a fresh copy. */
async function updateBasketMessage(ctx: Context, page: number) {
  if (!basket) return;
  const { text, kb } = renderBasket(basket, page);
  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/message is not modified/i.test(msg)) return;
    console.error("basket: couldn't update the message –", msg);
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    await showBasket(ctx.chat!.id, page);
  }
}

bot.on("callback_query:data", async (ctx) => {
  const [action, id, idx] = ctx.callbackQuery.data.split(":");
  const p = pending.get(id);
  await ctx.answerCallbackQuery();
  if (!p) return ctx.reply("That request expired – ask again.");
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);

  if (action === "no") {
    pending.delete(id);
    return ctx.reply("OK, left the cart alone.");
  }
  if (action === "like" && p.kind === "like") {
    const name = p.names[Number(idx)];
    if (name) await pickFor(ctx, "", name);
    return;
  }
  if (action === "ok" && p.kind === "tobasket") {
    pending.delete(id);
    if (!basket) return ctx.reply("No basket open any more – /shop builds one.");
    basket = addItem(basket, p.item);
    saveBasket(basket);
    return showBasket(ctx.chat!.id);
  }
  if (action === "ok" && p.kind === "add") {
    pending.delete(id);
    const r = await work<{ ok: boolean; problems: string[] }>(ctx, "Adding to the cart", (http) =>
      p.items.length === 1
        ? add(http, p.items[0].product, p.items[0].qty).then((x) => ({ ok: x.ok, problems: x.ok ? [] : [x.note ?? "cart didn't change"] }))
        : addItems(http, p.items),
    );
    if (!r) return;
    return ctx.reply(r.ok ? "✓ In the cart. Check out on mercatoronline.si when you're ready." : `Added, but please check:\n${r.problems.join("\n")}`);
  }
  if (action === "ok" && p.kind === "clear") {
    pending.delete(id);
    const ok = await work<boolean>(ctx, "Emptying the cart", (http) => clearCart(http));
    if (ok !== undefined) return ctx.reply(ok ? "🗑 Cart emptied." : "⚠️ Couldn't empty the cart – check it in the browser.");
  }
});

// ---------- background: keep product data fresh ----------

let refreshing = false;
/** Look up products in batches of 15, each its own task, so your messages are answered in between. */
async function refreshInBackground() {
  if (refreshing) return;
  refreshing = true;
  try {
    // instant local rebuild first (new orders → history.json), then lookups batch by batch
    await rebuildHistory(shop.anon, { maxLookups: 0 });
    let left = pendingLookups();
    if (left) console.log(`→ background: looking up ${left} products in batches`);
    while (left > 0) {
      await rebuildHistory(shop.anon, { maxLookups: 40, log: () => undefined });
      const now = pendingLookups();
      if (now >= left) break; // no progress – try again later
      left = now;
      console.log(`  background: ${left} left`);
    }
  } catch (err) {
    console.error("background refresh failed:", err instanceof Error ? err.message : err);
  } finally {
    refreshing = false;
  }
}

// ---------- daily check ----------

function scheduleDaily() {
  if (DAILY_AT === "off" || OWNER == null) return;
  const [h, m] = DAILY_AT.split(":").map(Number);
  const next = new Date();
  next.setHours(h, m || 0, 0, 0);
  if (next <= new Date()) next.setDate(next.getDate() + 1);
  setTimeout(async () => {
    try {
      // new orders first, so a delivery you already got isn't proposed again
      await importNewOrders(await shop.loggedIn(), { log: () => undefined });
      await refreshInBackground();
      await dueReport(OWNER, { quietIfNothing: true });
    } catch (err) {
      await send(OWNER, `⚠️ Daily check failed: ${esc(err instanceof Error ? err.message : String(err))}`).catch(() => undefined);
    }
    scheduleDaily();
  }, next.getTime() - Date.now());
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offset = new Intl.DateTimeFormat("en", { timeZone: zone, timeZoneName: "shortOffset" }).formatToParts(next).find((p) => p.type === "timeZoneName")?.value;
  console.log(`  daily check at ${next.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })} ${zone} (${offset}) – set TZ to change the zone`);
}

bot.catch((err) => console.error("bot error:", err.error));
await bot.api.setMyCommands(COMMANDS.map(({ command, description }) => ({ command, description })));
console.log(OWNER == null ? "→ Bot running. Send /start to it on Telegram to get your chat id." : `→ Bot running for chat ${OWNER}.`);
scheduleDaily();
void refreshInBackground();
process.once("SIGINT", async () => {
  await bot.stop();
  process.exit(0);
});
await bot.start();
