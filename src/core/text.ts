/** HTML → text with line breaks where a browser would put them (for label/value parsing). */
import { parseHTML } from "linkedom";

export function pageText(html: string, selector = "#main"): string {
  const marked = html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|li|tr|h\d|table|section|article|dt|dd)>|<br\s*\/?>/gi, "$&\n")
    .replace(/<\/(td|th)>/gi, "$&\t");
  const { document } = parseHTML(marked);
  const root = document.querySelector(selector) ?? document.body;
  return (root?.textContent ?? "")
    .replace(/ /g, " ")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}
