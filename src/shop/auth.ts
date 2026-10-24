/**
 * Login without a browser: fill the /prijava form (it posts to Mercator's central login at profil.mercator.si)
 * and follow the redirect chain back to the shop, keeping cookies on both domains. The session is saved to
 * .session.json (mode 600) and reused until the shop says we're logged out.
 */
import { readForm, setFields } from "../core/forms.ts";
import { Http } from "../core/http.ts";

export const SESSION_FILE = ".session.json";

/** The shop states it on every page: `ShopLib.loggedIn = true|false`. */
export function loggedInFlag(html: string): boolean | null {
  const m = html.match(/ShopLib\.loggedIn\s*=\s*(true|false)/);
  return m ? m[1] === "true" : null;
}

export async function isLoggedIn(http: Http): Promise<boolean> {
  return loggedInFlag((await http.html("/")).text) === true;
}

export async function login(http: Http, email: string, password: string): Promise<void> {
  const page = await http.html("/prijava");
  if (loggedInFlag(page.text)) return;
  const form = readForm(page.text, page.url, (f) => !!f.querySelector('input[name="txtPassword"]'));
  if (!form) throw new Error("Couldn't find the login form on /prijava – the page changed (see docs/mercator-api.md §2)");
  const fields = setFields(form.fields, { txtUserName: email, txtPassword: password, chkRememberMe: "on" });
  const res = await http.request(form.action, { method: "POST", form: fields, retry: false });
  if (!new URL(res.url).hostname.endsWith("mercatoronline.si")) {
    // stayed on profil.mercator.si → wrong credentials, captcha, verification…
    const msg = res.text.match(/class="[^"]*(?:error|alert|validation)[^"]*"[^>]*>([^<]{3,200})</i)?.[1]?.trim();
    throw new Error(`Login failed${msg ? `: ${msg}` : ""} (ended on ${res.url.split("?")[0]})`);
  }
  if (!(await isLoggedIn(http))) throw new Error("Login seemed to work but the shop still says logged out");
}

/** Reuse the saved session when it's still valid, else log in and save the new one. */
export async function ensureSession(http: Http, creds: { email: string; password: string }, file = SESSION_FILE) {
  if (http.loadSession(file) && (await isLoggedIn(http))) return;
  await login(http, creds.email, creds.password);
  http.saveSession(file);
}
