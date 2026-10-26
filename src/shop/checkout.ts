/**
 * Checkout over HTTP (docs/mercator-api.md §5): cart page → delivery slot → pay on delivery → review → confirm.
 *
 * ⚠ Experimental until one checkout has been recorded: the step transitions follow the site's own forms
 * (every field the page has is sent, like a browser) but haven't been observed end-to-end. Any surprise
 * stops with an error – nothing is ordered unless the review page was read and matches what you approved.
 * Only pay-on-delivery is supported; the agent never pays online and never handles card data.
 */
import { parseHTML } from "linkedom";
import { readForm, setFields } from "../core/forms.ts";
import { BASE, Http, type Res } from "../core/http.ts";
import { pageText } from "../core/text.ts";
import { cartLock } from "./cart.ts";

export const PAYMENT_METHODS = { offlineCard: "card on delivery", offlineCash: "cash on delivery" } as const;
export type PaymentMethod = keyof typeof PAYMENT_METHODS;

export function paymentMethod(): PaymentMethod {
  const m = process.env.PAYMENT_METHOD ?? "offlineCard";
  if (!(m in PAYMENT_METHODS)) throw new Error("PAYMENT_METHOD must be offlineCard or offlineCash (pay on delivery) – the agent never pays online");
  return m as PaymentMethod;
}

const PATH = {
  cart: "/blagajna/pregled-kosarice",
  delivery: "/blagajna/izbira-prevzema",
  payment: "/blagajna/izbira-placila",
  review: "/blagajna/pregled-in-potrditev",
  timetable: "/shop_cart/step_two/ajax_get_delivery_timetable",
};
const onPath = (res: Res, path: string) => new URL(res.url).pathname.startsWith(path);
function expectPath(res: Res, path: string, step: string) {
  if (!onPath(res, path)) {
    const notice = pageText(res.text, ".alert, .error, .text-danger").slice(0, 200);
    throw new Error(`Didn't get to ${step} (landed on ${new URL(res.url).pathname})${notice ? `: ${notice}` : ""}`);
  }
}

export type Slot = { value: string; granulation: string | null; day: string; time: string; price: number | null };

/** Free slots in a timetable HTML fragment (day column × time row; price in the cell). */
export function parseTimetable(html: string): Slot[] {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  return [...document.querySelectorAll("input[type=radio]")].flatMap((input) => {
    const td = input.closest("td");
    if (!td || input.hasAttribute("disabled") || !/prosto/i.test(td.textContent ?? "")) return [];
    const tr = td.parentElement!;
    const col = [...tr.children].indexOf(td);
    const table = td.closest("table")!;
    const head = table.querySelector("thead tr") ?? table.querySelector("tr");
    const price = (td.textContent ?? "").match(/(\d+[.,]\d{2})\s*EUR/)?.[1];
    return [{
      value: input.getAttribute("value") ?? "",
      granulation: input.getAttribute("granulation"),
      day: clean(head?.children[col]?.textContent),
      time: clean(tr.children[0]?.textContent),
      price: price ? Number(price.replace(",", ".")) : null,
    }];
  });
}

/** Step 1 → 2: open the cart page and follow its "continue" link/form; return the delivery page. */
async function enterCheckout(http: Http): Promise<Res> {
  const cart = await http.html(PATH.cart);
  if (/košarica je prazna/i.test(cart.text)) throw new Error("The cart is empty – nothing to check out");
  const { document } = parseHTML(cart.text);
  const next = [...document.querySelectorAll("a[href], button, input[type=submit]")].find((e) => /nadaljuj/i.test(e.textContent || e.getAttribute("value") || ""));
  const href = next?.getAttribute("href");
  let res: Res;
  if (href && !/^(#|javascript:)/i.test(href)) res = await http.html(new URL(href, cart.url).toString());
  else {
    const form = next ? readForm(cart.text, cart.url, (f) => f.contains(next)) : null;
    res = form ? await http.request(form.action, { method: form.method, form: form.fields, retry: false }) : await http.html(PATH.delivery);
  }
  expectPath(res, PATH.delivery, "the delivery step");
  return res;
}

/** Page settings the site's step2 script is configured with (renderPath, fromDate…), when present. */
function step2Settings(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/(renderPath|fromDate|selectedTimeFrameValue)\s*:\s*["']([^"']*)["']/g)) out[m[1]] = m[2];
  return out;
}

export type DeliveryStep = { page: Res; slots: Slot[] };

/** Steps 1–2: enter checkout and read the free home-delivery slots for your selected address. */
export async function openDelivery(http: Http): Promise<DeliveryStep> {
  const page = await enterCheckout(http);
  const { document } = parseHTML(page.text);
  const address =
    document.querySelector(".naslovZaDostavo.active, .naslovZaDostavo.selected, .naslovZaDostavo[class*=izbran]") ??
    document.querySelector(".naslovZaDostavo[addressid]");
  const addressId = address?.getAttribute("addressid") ?? document.querySelector('input[name="deliveryAddressId"]')?.getAttribute("value") ?? "";
  const settings = step2Settings(page.text);
  const j = await http.json<{ success?: boolean; timetableHtml?: string; error?: string }>(PATH.timetable, {
    type: "kliknadom",
    addressId,
    fromDate: settings.fromDate ?? "",
    timetableModelName: "radioTimetableDistributing",
    renderPath: settings.renderPath ?? "",
    selectedRangeDateTime: settings.selectedTimeFrameValue ?? "",
  });
  if (!j.success || !j.timetableHtml) throw new Error(`Couldn't load delivery slots: ${j.error ?? "unexpected answer"}`);
  return { page, slots: parseTimetable(j.timetableHtml) };
}

export type Review = {
  orderNo: string | null;
  when: string;
  payment: string;
  total: number;
  productsValue: number | null;
  delivery: number | null;
  items: number;
  /** "name | quantity | price" per product line, in page order – compared again before confirming */
  lines: string[];
};

/** Parse the review page's text ("Pregled in potrditev"). */
export function parseReview(text: string): Review {
  const after = (label: string) => text.split(label)[1]?.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const eur = (re: RegExp) => {
    const m = text.match(re);
    return m ? Number(m[1].replace(/\./g, "").replace(",", ".")) : null;
  };
  const total = eur(/Skupaj za plačilo:?\s*([\d.,]+)\s*EUR/i);
  if (total == null) throw new Error("Couldn't read the total on the review page");
  return {
    orderNo: text.match(/naročila\s*št\.?\s*(\d+)/i)?.[1] ?? null,
    when: after("Datum in čas dostave").replace(/\s+,/g, ","),
    payment: after("Izbrani načini plačila").replace(/\s+/g, " "),
    total,
    productsValue: eur(/Vrednost izdelkov:?\s*([\d.,]+)\s*EUR/i),
    delivery: eur(/Cena dostave:?\s*([\d.,]+)\s*EUR/i),
    items: (text.match(/^\s*[\d.,]+\s+Kos\b/gim) ?? []).length,
    lines: reviewLines(text),
  };
}

/** Product lines of the review page: the name above each "N Kos" line and the price below it. */
function reviewLines(text: string): string[] {
  const rows = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return rows.flatMap((row, i) => (/^[\d.,]+\s+Kos\b/i.test(row) && i > 0 ? [`${rows[i - 1]} | ${row} | ${rows[i + 1] ?? ""}`] : []));
}

/** Words the review page uses for each pay-on-delivery method ("Ob prevzemu z gotovino" = cash on delivery). */
const PAYMENT_WORDS: Record<PaymentMethod, RegExp> = { offlineCash: /gotovin/i, offlineCard: /kartic/i };

/** Why this review must not be confirmed, or null if it's fine. */
export function reviewProblem(now: Review, approved: Review, method: PaymentMethod): string | null {
  if (!now.when || !now.payment) return "couldn't read the delivery time or the payment on the review page";
  if (!/ob prevzemu/i.test(now.payment)) return `the payment isn't pay-on-delivery ("${now.payment}")`;
  const other = (Object.keys(PAYMENT_WORDS) as PaymentMethod[]).find((m) => m !== method && PAYMENT_WORDS[m].test(now.payment));
  if (other && !PAYMENT_WORDS[method].test(now.payment)) return `the payment is ${PAYMENT_METHODS[other]}, not ${PAYMENT_METHODS[method]}`;
  const same = (a: number | null, b: number | null) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) <= 0.005);
  if (!same(now.total, approved.total) || !same(now.productsValue, approved.productsValue) || !same(now.delivery, approved.delivery))
    return `the amounts changed (now ${now.total.toFixed(2)} €)`;
  if (now.when !== approved.when) return `the delivery time changed (now ${now.when})`;
  if (now.payment !== approved.payment) return `the payment changed (now ${now.payment})`;
  if (now.items !== approved.items || now.lines.join("\n") !== approved.lines.join("\n")) return "the products changed";
  return null;
}

/** Steps 2–4: submit the slot, choose pay on delivery, read the review page. Holds the cart lock throughout. */
export function prepareOrder(http: Http, step: DeliveryStep, slot: Slot, method: PaymentMethod): Promise<{ review: Review; page: Res }> {
  return cartLock.lock(async () => {
    const delivery = readForm(step.page.text, step.page.url, "#deliveryDataForm") ?? readForm(step.page.text, step.page.url, 'input[name="deliveryType"]');
    if (!delivery) throw new Error("Couldn't find the delivery form (docs/mercator-api.md §5, step 2)");
    const payPage = await http.request(delivery.action, {
      method: "POST",
      retry: false,
      form: setFields(delivery.fields, {
        deliveryType: "kliknadom",
        radioTimetableDistributing: slot.value,
        ...(slot.granulation ? { radioTimetableDistributingGranulation: slot.granulation } : {}),
      }),
    });
    expectPath(payPage, PATH.payment, "the payment step");

    const pay = readForm(payPage.text, payPage.url, 'input[name="fixedPayment"]');
    if (!pay) throw new Error("Couldn't find the payment form (step 3)");
    if (!payPage.text.includes(`value="${method}"`)) throw new Error(`"${PAYMENT_METHODS[method]}" isn't offered for this order`);
    const reviewPage = await http.request(pay.action, { method: "POST", retry: false, form: setFields(pay.fields, { fixedPayment: method }) });
    expectPath(reviewPage, PATH.review, "the review page");
    const review = parseReview(pageText(reviewPage.text));
    if (!review.when || !review.payment || !/ob prevzemu/i.test(review.payment))
      throw new Error(`The review page doesn't show a delivery time and pay-on-delivery ("${review.payment}") – not continuing`);
    return { review, page: reviewPage };
  });
}

/**
 * Place the order – the POST that the POTRDI NAROČILO button sends. Re-reads the review page first and refuses
 * unless total, slot and payment are exactly what you approved.
 */
export function confirmOrder(http: Http, approved: Review, note?: string, method: PaymentMethod = paymentMethod()): Promise<{ orderNo: string | null; message: string }> {
  return cartLock.lock(async () => {
    const page = await http.html(PATH.review);
    expectPath(page, PATH.review, "the review page");
    const now = parseReview(pageText(page.text));
    const problem = reviewProblem(now, approved, method);
    if (problem) throw new Error(`Not ordering: ${problem} – approve again`);
    const form = readForm(page.text, page.url, 'input[name="confirm-terms"]');
    if (!form) throw new Error("Couldn't find the confirmation form (step 4)");
    const done = await http.request(form.action, {
      method: "POST",
      retry: false,
      form: setFields(form.fields, { "confirm-terms": "on", ...(note ? { note } : {}) }),
    });
    if (onPath(done, PATH.review)) throw new Error(`Still on the review page after confirming: ${pageText(done.text).slice(0, 200)}`);
    const text = pageText(done.text);
    return { orderNo: text.match(/(\d{6,})/)?.[1] ?? approved.orderNo, message: text.split("\n").slice(0, 4).join(" · ") };
  });
}

export const shopUrl = (path: string) => new URL(path, BASE).toString();
