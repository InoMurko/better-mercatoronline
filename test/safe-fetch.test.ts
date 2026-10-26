import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { BlockedUrlError, checkUrl, isPublicIp, safeFetchHtml } from "../src/core/safe-fetch.ts";

test("public vs private addresses", () => {
  for (const ip of ["93.184.216.34", "1.1.1.1", "2a00:1450:4001:80b::200e", "2606:4700::1111"]) assert.ok(isPublicIp(ip), ip);
  for (const ip of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "224.0.0.1", "255.255.255.255", "198.18.0.1", "::1", "::", "fe80::1", "fd00::1", "fc00::1", "::ffff:127.0.0.1",
    "::ffff:7f00:1", "64:ff9b::7f00:1", "2002:7f00:1::", "2001:db8::1", "ff02::1", "not-an-ip",
  ]) assert.ok(!isPublicIp(ip), ip);
});

test("URLs refused before any network access", () => {
  const blocked = [
    "file:///etc/passwd", "javascript:alert(1)", "data:text/html,<b>x</b>", "ftp://example.com/", "gopher://example.com/",
    "http://user:pass@example.com/", "http://example.com:8080/", "http://example.com:22/",
    "http://localhost/", "http://foo.localhost/", "http://router.lan/", "http://printer.local/", "http://metadata.google.internal/",
    "http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/", "http://192.168.1.1/",
    // other spellings of 127.0.0.1 – the URL parser normalises them, the check still catches them
    "http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/", "http://127.1/", "http://[::ffff:127.0.0.1]/",
    "not a url",
  ];
  for (const u of blocked) assert.throws(() => checkUrl(u), BlockedUrlError, u);
  assert.equal(checkUrl("https://www.example.com/recept?id=1").hostname, "www.example.com");
});

/** A local server standing in for "the internet"; the tests allow 127.0.0.1 and its port explicitly. */
async function server(handler: Parameters<typeof createServer>[1]) {
  const srv = createServer(handler);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  return { port, base: `http://127.0.0.1:${port}`, opts: { allowIps: ["127.0.0.1"], allowPorts: [port] }, close: () => srv.close() };
}

test("fetches a normal page, sends no cookies, decodes the charset", async () => {
  let cookie: string | undefined = "unset";
  const s = await server((req, res) => {
    cookie = req.headers.cookie;
    res.writeHead(200, { "Content-Type": "text/html; charset=windows-1250" }).end(Buffer.from([0x3c, 0x70, 0x3e, 0x9a, 0x3c, 0x2f, 0x70, 0x3e])); // <p>š</p>
  });
  try {
    const page = await safeFetchHtml(`${s.base}/recipe`, s.opts);
    assert.equal(page.html, "<p>š</p>");
    assert.equal(cookie, undefined);
  } finally {
    s.close();
  }
});

test("a redirect to the cloud metadata address / a LAN host / localhost is refused", async () => {
  const s = await server((req, res) => {
    const to = { "/meta": "http://169.254.169.254/latest/meta-data/", "/lan": "http://192.168.1.1/admin", "/local": "http://localhost/", "/file": "file:///etc/passwd" }[req.url!];
    res.writeHead(302, { Location: to ?? "/" }).end();
  });
  try {
    for (const path of ["/meta", "/lan", "/local", "/file"]) await assert.rejects(safeFetchHtml(`${s.base}${path}`, s.opts), BlockedUrlError, path);
  } finally {
    s.close();
  }
});

test("at most 3 redirects", async () => {
  const s = await server((req, res) => {
    const n = Number(req.url!.slice(1));
    if (n < 10) res.writeHead(302, { Location: `/${n + 1}` }).end();
    else res.writeHead(200, { "Content-Type": "text/html" }).end("done");
  });
  try {
    await assert.rejects(safeFetchHtml(`${s.base}/0`, s.opts), /more than 3 redirects/);
    assert.equal((await safeFetchHtml(`${s.base}/7`, s.opts)).html, "done");
  } finally {
    s.close();
  }
});

test("DNS answers are checked: a name that resolves (even partly) to a private address is refused", async () => {
  const s = await server((_req, res) => res.writeHead(200, { "Content-Type": "text/html" }).end("secret"));
  try {
    const url = `http://evil.example:${s.port}/`;
    const allowPorts = [s.port];
    await assert.rejects(safeFetchHtml(url, { allowPorts, resolve: async () => ["127.0.0.1"] }), BlockedUrlError);
    await assert.rejects(safeFetchHtml(url, { allowPorts, resolve: async () => ["93.184.216.34", "127.0.0.1"] }), BlockedUrlError);
    await assert.rejects(safeFetchHtml(url, { allowPorts, resolve: async () => ["::1"] }), BlockedUrlError);
  } finally {
    s.close();
  }
});

test("too big (declared, streamed, or a gzip bomb), not HTML, or too slow → refused", async () => {
  const s = await server((req, res) => {
    if (req.url === "/declared") res.writeHead(200, { "Content-Type": "text/html", "Content-Length": "999999999" }).end();
    else if (req.url === "/stream") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("x".repeat(3_000_000));
    } else if (req.url === "/bomb") res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip" }).end(gzipSync(Buffer.alloc(50_000_000)));
    else if (req.url === "/json") res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    else if (req.url === "/exe") res.writeHead(200, { "Content-Type": "application/octet-stream" }).end("MZ");
    else if (req.url === "/slow") setTimeout(() => res.writeHead(200, { "Content-Type": "text/html" }).end("late"), 2000);
  });
  try {
    for (const path of ["/declared", "/stream", "/bomb", "/json", "/exe"]) await assert.rejects(safeFetchHtml(`${s.base}${path}`, s.opts), BlockedUrlError, path);
    await assert.rejects(safeFetchHtml(`${s.base}/slow`, { ...s.opts, timeoutMs: 300 }), /longer than/);
  } finally {
    s.close();
  }
});
