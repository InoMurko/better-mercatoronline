/**
 * HTTP for the shop: a cookie jar shared by mercatoronline.si and profil.mercator.si (login),
 * redirects followed by hand so cookies are kept on every hop, a cap on parallel requests,
 * and retries with backoff for GETs (never for POSTs – an add-to-cart must not run twice).
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { CookieJar } from "tough-cookie";
import { Limiter } from "./limiter.ts";

export const BASE = "https://mercatoronline.si";
/** Hosts the shop client may talk to (and their subdomains). Extra ones: MERCATOR_EXTRA_HOSTS=a.example,b.example */
export const SHOP_HOSTS = ["mercatoronline.si", "mercator.si"];
const TIMEOUT_MS = () => Number(process.env.MERCATOR_TIMEOUT_MS) || 30_000;
const MAX_BODY = 10_000_000;

export type Res = { status: number; url: string; headers: Headers; text: string };
export type ReqOpts = {
  method?: "GET" | "POST";
  form?: Record<string, string> | URLSearchParams | [string, string][];
  ajax?: boolean;
  headers?: Record<string, string>;
  maxRedirects?: number;
  /** retry on network errors / 5xx – on by default for GET only */
  retry?: boolean;
};

export class HttpError extends Error {
  constructor(message: string, readonly status: number, readonly url: string) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The response body as text, refusing more than `max` bytes. */
async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new HttpError(`response too big (${declared} bytes)`, res.status, res.url);
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(`response too big (over ${max} bytes)`, res.status, res.url);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class Http {
  jar: CookieJar;
  private limiter: Limiter;
  requests = 0;

  /** hosts (and subdomains) requests may go to – everything else is refused, including redirects */
  readonly hosts: string[];

  constructor(opts: { concurrency?: number; jar?: CookieJar; userAgent?: string; hosts?: string[] } = {}) {
    this.jar = opts.jar ?? new CookieJar();
    const extra = (process.env.MERCATOR_EXTRA_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
    this.hosts = opts.hosts ?? [...SHOP_HOSTS, ...extra];
    this.limiter = new Limiter(opts.concurrency ?? (Number(process.env.MERCATOR_CONCURRENCY) || 4));
    this.userAgent =
      opts.userAgent ??
      process.env.MERCATOR_USER_AGENT ??
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
  }
  readonly userAgent: string;

  abs(path: string) {
    return this.checkHost(new URL(path, BASE)).toString();
  }

  /** Only the shop's own hosts – a link or redirect elsewhere (from a changed or compromised page) is refused. */
  private checkHost(url: URL): URL {
    const host = url.hostname.toLowerCase();
    if (!this.hosts.some((h) => host === h || host.endsWith(`.${h}`)))
      throw new HttpError(`refusing to contact ${host} – not a Mercator host (set MERCATOR_EXTRA_HOSTS if the shop moved)`, 0, url.origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new HttpError(`refusing ${url.protocol} URL`, 0, url.origin);
    return url;
  }

  /** One request (plus its redirects), within the concurrency cap. */
  request(path: string, opts: ReqOpts = {}): Promise<Res> {
    return this.limiter.run(() => this.requestNow(path, opts));
  }

  private async requestNow(path: string, opts: ReqOpts): Promise<Res> {
    const method = opts.method ?? (opts.form ? "POST" : "GET");
    const retry = opts.retry ?? method === "GET";
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.follow(this.abs(path), method, opts);
        if (retry && res.status >= 500 && attempt < 3) throw new HttpError(`HTTP ${res.status}`, res.status, res.url);
        return res;
      } catch (err) {
        if (!retry || attempt >= 3) throw err;
        await sleep(500 * 2 ** attempt + Math.random() * 250);
      }
    }
  }

  private async follow(url: string, method: string, opts: ReqOpts): Promise<Res> {
    let body: string | undefined = opts.form ? new URLSearchParams(opts.form as Record<string, string>).toString() : undefined;
    for (let hop = 0; hop <= (opts.maxRedirects ?? 10); hop++) {
      const headers: Record<string, string> = {
        "User-Agent": this.userAgent,
        Accept: opts.ajax ? "application/json, text/javascript, */*; q=0.01" : "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "sl-SI,sl;q=0.9,en;q=0.8",
        ...(opts.ajax ? { "X-Requested-With": "XMLHttpRequest" } : {}),
        ...(body ? { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" } : {}),
        ...opts.headers,
      };
      const cookie = await this.jar.getCookieString(url);
      if (cookie) headers.Cookie = cookie;
      this.requests++;
      // per hop: connect, headers and body within MERCATOR_TIMEOUT_MS (30 s) – a hung shop can't hold the cart lock forever
      const res = await fetch(url, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS()) });
      for (const c of res.headers.getSetCookie()) await this.jar.setCookie(c, url, { ignoreError: true });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        const next = this.checkHost(new URL(location, url));
        if (new URL(url).protocol === "https:" && next.protocol !== "https:") throw new HttpError(`refusing a redirect from https to ${next.origin}`, res.status, url);
        url = next.toString();
        if (res.status !== 307 && res.status !== 308) {
          method = "GET";
          body = undefined;
        }
        await res.arrayBuffer().catch(() => undefined);
        continue;
      }
      return { status: res.status, url, headers: res.headers, text: await readCapped(res, MAX_BODY) };
    }
    throw new HttpError("Too many redirects", 0, url);
  }

  async html(path: string): Promise<Res> {
    const res = await this.request(path);
    if (res.status >= 400) throw new HttpError(`GET ${path} → HTTP ${res.status}`, res.status, res.url);
    return res;
  }

  /** AJAX call returning JSON (GET with query, or POST with a form body). */
  async json<T = Record<string, unknown>>(path: string, form?: ReqOpts["form"]): Promise<T> {
    const res = await this.request(path, { ajax: true, form, method: form ? "POST" : "GET" });
    if (res.status >= 400) throw new HttpError(`${form ? "POST" : "GET"} ${path} → HTTP ${res.status}`, res.status, res.url);
    try {
      return JSON.parse(res.text) as T;
    } catch {
      throw new HttpError(`${path} didn't return JSON (got ${res.text.slice(0, 80).replace(/\s+/g, " ")}…)`, res.status, res.url);
    }
  }

  saveSession(file: string) {
    writeFileSync(file, JSON.stringify(this.jar.serializeSync()), { mode: 0o600 });
    chmodSync(file, 0o600); // the mode above only applies when the file is created
  }
  loadSession(file: string): boolean {
    if (!existsSync(file)) return false;
    try {
      this.jar = CookieJar.deserializeSync(JSON.parse(readFileSync(file, "utf8")));
      return true;
    } catch {
      return false;
    }
  }
}
