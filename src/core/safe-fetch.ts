/**
 * Fetch a web page a stranger chose (a recipe link) without letting it reach anything private.
 *
 * - http/https only, standard ports only, no user:password@ in the URL
 * - every address the host resolves to must be public: no localhost, LAN (192.168.x, 10.x …), link-local,
 *   cloud metadata (169.254.169.254), CGNAT, multicast, IPv6 private/mapped ranges
 * - the address we checked is the address we connect to (the check runs inside the socket's DNS lookup),
 *   so a DNS answer can't change between the check and the connection
 * - redirects are followed by hand, at most 3, and every hop is checked again
 * - 10 s for the whole thing, 2 MB at most (also after decompression), HTML only
 * - its own client: no cookies, no shop session, no proxy settings, no credentials are ever sent
 * - the HTML is only parsed later – nothing on the page is ever executed
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Readable } from "node:stream";

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

export type SafeFetchOptions = {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** test-only: exact IPs to allow in addition to public ones (e.g. a local test server) */
  allowIps?: string[];
  /** test-only: extra ports to allow besides 80/443 */
  allowPorts?: number[];
  /** test-only: replace DNS */
  resolve?: (host: string) => Promise<string[]>;
};

export type SafePage = { url: string; html: string; redirects: string[] };

// two lists: a BlockList also matches IPv4 against IPv6 rules (as ::ffff:a.b.c.d), so they mustn't share one
const blocked4 = new BlockList();
const blocked6 = new BlockList();
// IPv4 – "this network", private, CGNAT, loopback, link-local (cloud metadata), IETF/test/benchmark, multicast, reserved
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked4.addSubnet(net, bits, "ipv4");
// IPv6 – unspecified, loopback, IPv4-mapped/translated, discard, Teredo, docs, 6to4, ULA, link-local, site-local, multicast
for (const [net, bits] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001::", 32], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) blocked6.addSubnet(net, bits, "ipv6");

/** True for addresses on the public internet. */
export function isPublicIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return !blocked4.check(ip, "ipv4");
  if (v === 6) {
    const lower = ip.toLowerCase();
    // ::ffff:a.b.c.d written in dotted form – judge the IPv4 inside
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return false;
    // only global unicast (2000::/3) is public
    if (!/^[23][0-9a-f]{0,3}:/.test(lower)) return false;
    return !blocked6.check(ip, "ipv6");
  }
  return false;
}

const DEFAULT_PORTS = new Set([80, 443]);

/** Is this URL allowed at all (before any DNS)? Returns the parsed URL or throws BlockedUrlError. */
export function checkUrl(raw: string, opts: SafeFetchOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError("not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedUrlError(`only http and https links are allowed (got ${url.protocol})`);
  if (url.username || url.password) throw new BlockedUrlError("links with a user name or password are not allowed");
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!DEFAULT_PORTS.has(port) && !opts.allowPorts?.includes(port)) throw new BlockedUrlError(`port ${port} is not allowed`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new BlockedUrlError("no host");
  if (isIP(host)) assertAllowed(host, opts);
  else if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home\.arpa)$/i.test(host)) throw new BlockedUrlError(`${host} is a local name`);
  return url;
}

function assertAllowed(ip: string, opts: SafeFetchOptions) {
  if (opts.allowIps?.includes(ip)) return;
  if (!isPublicIp(ip)) throw new BlockedUrlError(`${ip} is not a public internet address`);
}

const systemResolve = (host: string) =>
  new Promise<string[]>((resolve, reject) =>
    dnsLookup(host, { all: true, verbatim: true }, (err, addrs: LookupAddress[]) => (err ? reject(err) : resolve(addrs.map((a) => a.address)))),
  );

/**
 * The socket's DNS lookup: resolve, refuse if ANY answer is private (a host mixing public and private answers is a trick),
 * then hand the socket exactly the address we checked.
 */
function guardedLookup(opts: SafeFetchOptions) {
  const resolve = opts.resolve ?? systemResolve;
  return (hostname: string, options: { all?: boolean } | number, callback: (...args: any[]) => void) => {
    const host = hostname.replace(/^\[|\]$/g, "");
    const all = typeof options === "object" && options?.all;
    const done = (ips: string[]) => {
      try {
        if (!ips.length) throw new BlockedUrlError(`${host} has no address`);
        for (const ip of ips) assertAllowed(ip, opts);
        const ip = ips[0];
        const family = isIP(ip);
        if (all) callback(null, [{ address: ip, family }]);
        else callback(null, ip, family);
      } catch (err) {
        callback(err);
      }
    };
    if (isIP(host)) return done([host]);
    resolve(host).then(done, (err) => callback(err));
  };
}

function decompressed(res: http.IncomingMessage): Readable {
  const enc = String(res.headers["content-encoding"] ?? "").toLowerCase().trim();
  if (enc === "gzip" || enc === "x-gzip") return res.pipe(createGunzip());
  if (enc === "deflate") return res.pipe(createInflate());
  if (enc === "br") return res.pipe(createBrotliDecompress());
  if (enc && enc !== "identity") throw new BlockedUrlError(`unsupported content encoding ${enc}`);
  return res;
}

function charsetOf(contentType: string): string {
  const m = contentType.match(/charset\s*=\s*"?([\w.:-]+)/i);
  return m ? m[1].toLowerCase() : "utf-8";
}

function decode(buf: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

type Hop = { status: number; location?: string; html?: string };

function oneHop(url: URL, opts: Required<Pick<SafeFetchOptions, "maxBytes">> & SafeFetchOptions, signal: AbortSignal): Promise<Hop> {
  const lib = url.protocol === "https:" ? https : http;
  return new Promise<Hop>((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: "GET",
        lookup: guardedLookup(opts) as any,
        agent: false, // fresh connection – never reuse a socket opened for another host
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; merc-recipe-reader/1.0)",
          Accept: "text/html,application/xhtml+xml;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
          "Accept-Language": "sl,en;q=0.8",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, location: res.headers.location });
        }
        if (status < 200 || status >= 300) {
          res.resume();
          return reject(new Error(`the page answered ${status}`));
        }
        const type = String(res.headers["content-type"] ?? "");
        if (!/^\s*(text\/html|application\/xhtml\+xml)\b/i.test(type)) {
          res.resume();
          return reject(new BlockedUrlError(`not a web page (${type.split(";")[0] || "no content type"})`));
        }
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > opts.maxBytes) {
          res.destroy();
          return reject(new BlockedUrlError(`the page is too big (${declared} bytes)`));
        }
        let body: Readable;
        try {
          body = decompressed(res);
        } catch (err) {
          res.destroy();
          return reject(err);
        }
        const chunks: Buffer[] = [];
        let size = 0;
        body.on("data", (c: Buffer) => {
          size += c.length;
          if (size > opts.maxBytes) {
            res.destroy();
            body.destroy();
            reject(new BlockedUrlError(`the page is too big (over ${opts.maxBytes} bytes)`));
            return;
          }
          chunks.push(c);
        });
        body.on("end", () => resolve({ status, html: decode(Buffer.concat(chunks), charsetOf(type)) }));
        body.on("error", reject);
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Fetch a public HTML page safely. Throws BlockedUrlError for anything outside the rules above. */
export async function safeFetchHtml(raw: string, options: SafeFetchOptions = {}): Promise<SafePage> {
  const opts = { maxBytes: 2_000_000, timeoutMs: 10_000, maxRedirects: 3, ...options };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new BlockedUrlError(`the page took longer than ${opts.timeoutMs / 1000} s`)), opts.timeoutMs);
  const redirects: string[] = [];
  try {
    let url = checkUrl(raw, opts);
    for (let hop = 0; ; hop++) {
      const res = await oneHop(url, opts, ctrl.signal).catch((err) => {
        throw ctrl.signal.aborted ? ctrl.signal.reason : err;
      });
      if (res.html != null) return { url: url.href, html: res.html, redirects };
      if (!res.location) throw new Error(`redirect (${res.status}) without a target`);
      if (hop >= opts.maxRedirects) throw new BlockedUrlError(`more than ${opts.maxRedirects} redirects`);
      url = checkUrl(new URL(res.location, url).href, opts);
      redirects.push(url.href);
    }
  } finally {
    clearTimeout(timer);
  }
}
