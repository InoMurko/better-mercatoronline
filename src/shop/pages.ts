/**
 * Plain-code readers for Mercator's account pages ("Moja naročila" list and an order's details).
 * They look for tables by their header / cell labels, not by position, and return null when the
 * page doesn't look the way they expect – callers then fall back to the AI.
 */
import { parseHTML } from "linkedom";
import type { OrderLine } from "../app/order.ts";

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const num = (s: string) => Number(s.replace(/EUR|€/g, "").trim().replace(/\.(?=\d{3}\b)/g, "").replace(",", "."));
const isoDate = (s: string) => {
  const m = s.match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
};

/** Cell text with its mobile label ("Status : ", "Cena / Kos : ") removed. */
function cellValue(td: Element): string {
  const label = td.querySelector("span.hidden-xs, span[class*='hidden-']");
  const text = clean(td.textContent);
  return label ? clean(text.slice(clean(label.textContent).length)).replace(/^:\s*/, "") : text;
}
/** Find a row's cell by its label text, e.g. "Izdobavljena količina". */
function byLabel(tr: Element, label: RegExp): string | null {
  for (const td of tr.querySelectorAll("td")) {
    const l = td.querySelector("span[class*='hidden-']");
    if (l && label.test(clean(l.textContent))) return cellValue(td);
  }
  return null;
}

export type ListedOrder = { orderNo: string; date: string; status: string; paid: number | null; detailsUrl: string };

export function parseOrderList(html: string): ListedOrder[] | null {
  const { document } = parseHTML(html);
  const table = [...document.querySelectorAll("table")].find((t) => /Številka naročila/i.test(clean(t.querySelector("thead, tr")?.textContent)));
  if (!table) return null;
  const out: ListedOrder[] = [];
  for (const tr of table.querySelectorAll("tbody tr")) {
    const link = tr.querySelector("a[href]");
    const text = clean(tr.textContent);
    const orderNo = byLabel(tr, /naročila/i)?.match(/\d{4,}/)?.[0] ?? text.match(/\b\d{6,}\b/)?.[0];
    const date = isoDate(text);
    if (!orderNo || !date || !link) continue;
    const statusCell = byLabel(tr, /^Status/i) ?? "";
    const paid = byLabel(tr, /Vrednost|plačil/i);
    out.push({
      orderNo,
      date,
      status: clean(statusCell.replace(/\d{1,2}\.\d{1,2}\.\d{4}.*$/, "")),
      paid: paid ? num(paid) : null,
      detailsUrl: link.getAttribute("href")!,
    });
  }
  return out.length ? out : null;
}

export type DetailLine = OrderLine & { ordered: number; lineTotal: number | null };
/** productsValue: the page's "Vrednost izdelkov" – can be lower than the lines' sum (order-level discounts). */
export type OrderDetails = { lines: DetailLine[]; productsValue: number | null };

export function parseOrderDetails(html: string): OrderDetails | null {
  const { document } = parseHTML(html);
  const rows = [...document.querySelectorAll("tr")].filter((tr) => byLabel(tr, /Izdobavljena količina|Naročena količina/i) != null);
  if (!rows.length) return null;
  const lines = rows
    .map((tr) => {
      const name = clean(tr.querySelector(".td-name")?.textContent) || clean(tr.querySelector("td:not(.td-images)")?.textContent);
      const ordered = num(byLabel(tr, /Naročena količina/i) ?? "0");
      const deliveredRaw = byLabel(tr, /Izdobavljena količina/i);
      const delivered = deliveredRaw != null ? num(deliveredRaw) : ordered;
      const unitPrice = num(byLabel(tr, /Cena/i) ?? "NaN");
      const total = byLabel(tr, /^Skupaj/i);
      return { name, quantity: delivered, ordered, unitPrice, lineTotal: total ? num(total) : null };
    })
    .filter((l) => l.name && Number.isFinite(l.unitPrice));

  const text = clean(document.body?.textContent);
  const value = text.match(/Vrednost izdelkov\s*:?\s*([\d.,]+)\s*EUR/i)?.[1];
  return { lines, productsValue: value ? num(value) : null };
}
