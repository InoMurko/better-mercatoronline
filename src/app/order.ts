/** Orders as text: the "Naročeni izdelki" table format (as in Mercator's e-mails), plus "# key: value" header lines. */
export type OrderLine = { name: string; quantity: number; unitPrice: number };

const eur = (s: string) => Number(s.replace(/EUR|€/g, "").trim().replace(/\./g, "").replace(",", "."));

export function parseOrder(text: string): OrderLine[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const header = lines.findIndex((l, i) => l === "Izdelek" && lines[i + 1] === "Kol");
  if (header < 0) throw new Error("Couldn't find the 'Izdelek / Kol / Cena / kos / Skupaj' table");
  const out: OrderLine[] = [];
  for (let i = header + 4; i + 3 < lines.length; i += 4) {
    if (/^Vrednost izdelkov/i.test(lines[i])) break;
    const [name, qty, price] = lines.slice(i, i + 3);
    if (!/^\d+([.,]\d+)?$/.test(qty) || !/EUR|€/.test(price)) {
      throw new Error(`Unexpected table row at "${name}" / "${qty}" / "${price}"`);
    }
    out.push({ name, quantity: Number(qty.replace(",", ".")), unitPrice: eur(price) });
  }
  return out;
}


/** The canonical text form we store in orders/*.txt (readable, and parseOrder reads it back). */
export function formatOrder(lines: OrderLine[], header: string[] = []): string {
  const money = (n: number) => `${n.toFixed(2).replace(".", ",")} EUR`;
  const qty = (q: number) => String(+q.toFixed(3)).replace(".", ",");
  const rows = lines.flatMap((l) => [l.name, qty(l.quantity), money(l.unitPrice), money(l.quantity * l.unitPrice)]);
  const total = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
  return [...header, "Naročeni izdelki", "Izdelek", "Kol", "Cena / kos", "Skupaj", ...rows, "Vrednost izdelkov:", money(total)].join("\n\n") + "\n";
}

export type OrderFile = { date: string | null; orderNo: string | null; lines: OrderLine[] };

/** Read an orders/*.txt file: header lines like "# date: 2024-03-02" / "# order: 123456", then the table. */
export function readOrderText(text: string, fileName = ""): OrderFile {
  const header = (key: string) => text.match(new RegExp(`^#\\s*${key}:\\s*(.+)$`, "m"))?.[1].trim() ?? null;
  const date = header("date") ?? fileName.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
  return { date, orderNo: header("order"), lines: parseOrder(text) };
}
