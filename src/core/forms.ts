/**
 * Read an HTML form the way a browser would submit it: every named, enabled field with its current value
 * (checked checkboxes/radios only, selected <option>s), so hidden fields we don't know about are sent too.
 */
import { parseHTML } from "linkedom";

export type Form = { action: string; method: "GET" | "POST"; fields: [string, string][] };

export function readForm(html: string, pageUrl: string, match: string | ((form: Element) => boolean)): Form | null {
  const { document } = parseHTML(html);
  const forms = [...document.querySelectorAll("form")];
  const form = typeof match === "string" ? forms.find((f) => f.matches(match) || f.querySelector(match)) : forms.find(match);
  if (!form) return null;
  const fields: [string, string][] = [];
  for (const el of form.querySelectorAll("input, select, textarea")) {
    const name = el.getAttribute("name");
    if (!name || el.hasAttribute("disabled")) continue;
    const tag = el.tagName.toLowerCase();
    if (tag === "select") {
      const opt = el.querySelector("option[selected]") ?? el.querySelector("option");
      if (opt) fields.push([name, opt.getAttribute("value") ?? opt.textContent ?? ""]);
      continue;
    }
    if (tag === "textarea") {
      fields.push([name, el.textContent ?? ""]);
      continue;
    }
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    if (["submit", "button", "image", "reset", "file"].includes(type)) continue;
    if ((type === "checkbox" || type === "radio") && !el.hasAttribute("checked")) continue;
    fields.push([name, el.getAttribute("value") ?? (type === "checkbox" ? "on" : "")]);
  }
  const action = new URL(form.getAttribute("action") || pageUrl, pageUrl).toString();
  return { action, method: (form.getAttribute("method") ?? "GET").toUpperCase() === "POST" ? "POST" : "GET", fields };
}

/** Replace (or add) fields; `null` removes a field. */
export function setFields(fields: [string, string][], values: Record<string, string | null>): [string, string][] {
  const out = fields.filter(([k]) => !(k in values));
  for (const [k, v] of Object.entries(values)) if (v != null) out.push([k, v]);
  return out;
}
