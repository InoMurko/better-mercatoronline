/**
 * Command line for the API agent.
 *
 *   npm run cli -- login                      check the login works (saves the session)
 *   npm run cli -- import [--max 5]           fetch new orders into orders/ (in parallel)
 *   npm run cli -- history                    look up every product you've bought (in parallel) → history.json
 *   npm run cli -- due [--all] [--horizon 10] what's running low
 *   npm run cli -- shop [--add]               the basket the agent thinks you need (--add puts it in the cart, asks first)
 *   npm run cli -- pick "toaletni papir" [--like "…"] [--qty 2] [--cheapest] [--add]
 *   npm run cli -- cheapest mleko [--category "SVEŽE MLEKO,TRAJNO MLEKO"] [--by unit|price] [--add] [--qty 1]
 *   npm run cli -- cart [clear] [--yes]
 *   npm run cli -- checkout                   pick a slot, pay on delivery, review, confirm (asks; experimental)
 */
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { ShopSession } from "./app/session.ts";
import { rebuildHistory } from "./app/history.ts";
import { fmtProduct, planPick } from "./app/picking.ts";
import { addItems, buildBasket, defaultHorizon, describeHabit, loadHabits } from "./app/restock.ts";
import { priceLine } from "./app/offers.ts";
import { add, clearCart, readCart } from "./shop/cart.ts";
import { confirmOrder, openDelivery, PAYMENT_METHODS, paymentMethod, prepareOrder } from "./shop/checkout.ts";
import { importNewOrders } from "./shop/orders.ts";
import { findCheapest } from "./shop/products.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    max: { type: "string" }, concurrency: { type: "string" }, all: { type: "boolean", default: false },
    horizon: { type: "string" }, add: { type: "boolean", default: false }, yes: { type: "boolean", short: "y", default: false },
    like: { type: "string" }, qty: { type: "string" }, cheapest: { type: "boolean", default: false },
    category: { type: "string" }, by: { type: "string", default: "unit" }, "no-llm": { type: "boolean", default: false },
  },
});
const [command, ...rest] = positionals;
const shop = new ShopSession();
const eur = (n: number) => `${n.toFixed(2).replace(".", ",")} €`;
const num = (s?: string) => (s ? Number(s) || undefined : undefined);

async function ask(question: string): Promise<boolean> {
  if (values.yes) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${question} [y/N] `)).trim();
  rl.close();
  return /^(y|yes|d|da)$/i.test(a);
}

const commands: Record<string, () => Promise<void>> = {
  async login() {
    await shop.loggedIn();
    console.log("✓ Logged in – session saved to .session.json");
  },

  async import() {
    const t = Date.now();
    const r = await importNewOrders(await shop.loggedIn(), { max: num(values.max), concurrency: num(values.concurrency) });
    console.log(`✓ ${r.added.length} new, ${r.failed.length} failed, ${r.found} in your account (${((Date.now() - t) / 1000).toFixed(1)} s, ${shop.http.requests} requests)`);
  },

  async history() {
    const t = Date.now();
    const h = await rebuildHistory(shop.anon, { concurrency: num(values.concurrency) });
    console.log(`✓ history.json: ${h.length} products, ${h.filter((e) => e.product).length} found in the shop (${((Date.now() - t) / 1000).toFixed(1)} s)`);
  },

  async due() {
    const horizon = num(values.horizon) ?? defaultHorizon();
    const all = await loadHabits(shop.anon, { horizon });
    const label = { due: "DUE ", soon: "soon", ok: "ok  ", dormant: "—   ", "too-few": "?   " };
    for (const h of values.all ? all : all.filter((x) => ["due", "soon", "ok"].includes(x.status))) {
      const [a, b] = describeHabit(h);
      console.log(`  ${label[h.status]}  ${a}\n        ${b}`);
    }
  },

  async shop() {
    const res = await buildBasket(shop.anon, { useLlm: !values["no-llm"] });
    console.log(`${res.due.length} due, ${res.soon.length} soon:`);
    for (const i of res.items) console.log(`  ${i.qty} × ${i.product.name} – ${eur(priceLine(i.product, i.qty).final)}   (${i.why ?? i.note})`);
    for (const u of res.unavailable) console.log(`  ✗ ${u}: not sold any more, nothing similar`);
    const total = res.items.reduce((s, i) => s + priceLine(i.product, i.qty).final, 0);
    console.log(`  ≈ ${eur(total)}`);
    if (!values.add || !res.items.length || !(await ask(`Put these ${res.items.length} in the cart?`))) return;
    const r = await addItems(await shop.loggedIn(), res.items, (d, n) => process.stdout.write(`\r  ${d}/${n}`));
    console.log(`\n✓ ${r.added}/${res.items.length} added`);
    for (const p of r.problems) console.log(`  ✗ ${p}`);
  },

  async pick() {
    const plan = await planPick(shop.anon, rest.join(" "), { like: values.like, qty: num(values.qty), cheapest: values.cheapest, useLlm: !values["no-llm"] });
    for (const l of plan.lines) console.log(l);
    for (const n of plan.alsoBought) console.log(`   also bought: ${n}  → --like "${n}"`);
    if (!plan.choice) return plan.options.forEach((p) => console.log(`   ${fmtProduct(p)}  [${p.category}]`));
    const pl = priceLine(plan.choice, plan.qty);
    console.log(`→ ${plan.qty} × ${plan.choice.name} = ${eur(pl.final)}${pl.notes.length ? `  (${pl.notes.join(" · ")})` : ""}`);
    if (values.add && (await ask("Add to cart?"))) {
      const r = await add(await shop.loggedIn(), plan.choice, plan.qty);
      console.log(r.ok ? "✓ added" : `✗ ${r.note}`);
    }
  },

  async cheapest() {
    const ranked = await findCheapest(shop.anon, rest.join(" "), {
      categories: values.category?.split(",").map((c) => c.trim()).filter(Boolean),
      by: values.by === "price" ? "price" : "unit",
    });
    if (!ranked.length) throw new Error("No matching products");
    for (const p of ranked.slice(0, 5)) console.log(`  ${fmtProduct(p)}  [${p.category}]`);
    const qty = num(values.qty) ?? 1;
    if (values.add && (await ask(`Add ${qty} × ${ranked[0].name}?`))) {
      const r = await add(await shop.loggedIn(), ranked[0], qty);
      console.log(r.ok ? "✓ added" : `✗ ${r.note}`);
    }
  },

  async cart() {
    const http = await shop.loggedIn();
    const lines = await readCart(http);
    for (const l of lines) console.log(`  ${l.quantity} × ${l.name}${l.lineTotal != null ? ` – ${eur(l.lineTotal)}` : ""}`);
    console.log(lines.length ? `  ${lines.length} lines, ${eur(lines.reduce((s, l) => s + (l.lineTotal ?? 0), 0))}` : "  The cart is empty.");
    if (rest[0] === "clear" && lines.length && (await ask("Empty the whole cart?"))) console.log((await clearCart(http)) ? "✓ emptied" : "✗ couldn't empty it");
  },

  async checkout() {
    const http = await shop.loggedIn();
    const method = paymentMethod();
    const step = await openDelivery(http);
    if (!step.slots.length) throw new Error("No free delivery slots");
    step.slots.forEach((s, i) => console.log(`  ${String(i + 1).padStart(2)}. ${s.day} ${s.time}${s.price != null ? ` – ${eur(s.price)}` : ""}`));
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const pickNo = Number((await rl.question("Slot number (empty = cancel): ")).trim());
    rl.close();
    const slot = step.slots[pickNo - 1];
    if (!slot) return console.log("Cancelled – nothing ordered.");
    const { review } = await prepareOrder(http, step, slot, method);
    console.log(`\nReview${review.orderNo ? ` (#${review.orderNo})` : ""}: ${review.items} products, ${review.when}, ${review.payment}\nTotal ${eur(review.total)} – ${PAYMENT_METHODS[method]}`);
    console.log("Confirming accepts Mercator's terms of business (Pogoji poslovanja).");
    const rl2 = createInterface({ input: process.stdin, output: process.stdout });
    const typed = (await rl2.question('Type "order" to place it: ')).trim();
    rl2.close();
    if (typed !== "order") return console.log("Not ordered.");
    const r = await confirmOrder(http, review, process.env.DELIVERY_NOTE || undefined);
    console.log(`🎉 Order placed${r.orderNo ? ` – #${r.orderNo}` : ""}. ${r.message}`);
  },
};

const run = commands[command ?? ""];
if (!run) {
  console.log("Commands: " + Object.keys(commands).join(", ") + "  (see src/cli.ts for options)");
  process.exit(command ? 1 : 0);
}
run().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exit(1);
});
