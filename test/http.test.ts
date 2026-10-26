import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { Http } from "../src/core/http.ts";
import { Limiter, mapLimit, Mutex } from "../src/core/limiter.ts";

/** A local server that mimics the shop's behaviour we rely on. */
async function server(): Promise<{ base: string; stats: { inFlight: number; maxInFlight: number; posts: number; flaky: number }; close: () => void }> {
  const stats = { inFlight: 0, maxInFlight: 0, posts: 0, flaky: 0 };
  const srv: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/login" && req.method === "POST") {
      stats.posts++;
      res.writeHead(302, { Location: "/sso", "Set-Cookie": "sso=1; Path=/" }).end();
    } else if (url.pathname === "/sso") {
      res.writeHead(302, { Location: "/home", "Set-Cookie": "session=abc; Path=/; HttpOnly" }).end();
    } else if (url.pathname === "/home") {
      res.end(`cookies=${req.headers.cookie ?? ""}`);
    } else if (url.pathname === "/slow") {
      stats.inFlight++;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      await new Promise((r) => setTimeout(r, 40));
      stats.inFlight--;
      res.end("ok");
    } else if (url.pathname === "/flaky") {
      stats.flaky++;
      res.writeHead(stats.flaky < 3 ? 503 : 200).end(stats.flaky < 3 ? "busy" : '{"success":true}');
    } else if (url.pathname === "/post-fails") {
      stats.posts++;
      res.writeHead(503).end("busy");
    } else res.writeHead(404).end();
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, stats, close: () => srv.close() };
}

test("POST → 302 → 302: cookies kept on every hop, final GET carries them all", async () => {
  const s = await server();
  try {
    const http = new Http({ concurrency: 2, hosts: ["127.0.0.1"] });
    const res = await http.request(`${s.base}/login`, { method: "POST", form: { user: "a", pass: "b" }, retry: false });
    assert.equal(new URL(res.url).pathname, "/home");
    assert.match(res.text, /sso=1/);
    assert.match(res.text, /session=abc/);
  } finally {
    s.close();
  }
});

test("concurrency cap is respected", async () => {
  const s = await server();
  try {
    const http = new Http({ concurrency: 3, hosts: ["127.0.0.1"] });
    await Promise.all(Array.from({ length: 12 }, () => http.request(`${s.base}/slow`)));
    assert.equal(s.stats.maxInFlight, 3);
  } finally {
    s.close();
  }
});

test("GETs are retried on 5xx; POSTs never (an add-to-cart must not run twice)", async () => {
  const s = await server();
  try {
    const http = new Http({ hosts: ["127.0.0.1"] });
    assert.deepEqual(await http.json(`${s.base}/flaky`), { success: true });
    assert.equal(s.stats.flaky, 3);
    const before = s.stats.posts;
    await assert.rejects(http.json(`${s.base}/post-fails`, { a: "1" }));
    assert.equal(s.stats.posts - before, 1);
  } finally {
    s.close();
  }
});

test("Limiter / mapLimit / Mutex", async () => {
  let active = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12]);
  assert.equal(peak, 2);
  const m = new Mutex();
  const order: number[] = [];
  await Promise.all([3, 1, 2].map((d, i) => m.lock(async () => {
    await new Promise((r) => setTimeout(r, d * 5));
    order.push(i);
  })));
  assert.deepEqual(order, [0, 1, 2], "mutex runs in call order, one at a time");
  assert.throws(() => new Limiter(0));
});

test("shop client: only Mercator hosts, no https→http downgrade, capped body, timeout", async () => {
  const s = await server();
  try {
    const shop = new Http();
    assert.equal(shop.abs("/x"), "https://mercatoronline.si/x");
    assert.equal(shop.abs("https://profil.mercator.si/sign-in.aspx"), "https://profil.mercator.si/sign-in.aspx");
    assert.throws(() => shop.abs("https://evilmercatoronline.si/"), /not a Mercator host/);
    assert.throws(() => shop.abs("http://192.168.1.1/"), /not a Mercator host/);
    // a redirect from an allowed host to another host is refused
    const local = new Http({ hosts: ["127.0.0.1"] });
    const { createServer } = await import("node:http");
    const srv = createServer((req, res) => {
      if (req.url === "/away") res.writeHead(302, { Location: "http://169.254.169.254/" }).end();
      else if (req.url === "/big") res.writeHead(200, { "Content-Length": "20000000" }).end();
      else if (req.url === "/hang") setTimeout(() => res.end("late"), 3000);
      else res.end("ok");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    await assert.rejects(local.request(`${base}/away`, { retry: false }), /not a Mercator host/);
    await assert.rejects(local.request(`${base}/big`, { retry: false }), /too big/);
    process.env.MERCATOR_TIMEOUT_MS = "300";
    await assert.rejects(local.request(`${base}/hang`, { retry: false }), /abort|timeout/i);
    delete process.env.MERCATOR_TIMEOUT_MS;
    srv.closeAllConnections();
    srv.close();
  } finally {
    s.close();
  }
});

test("limiter never exceeds max; mutex waiters give up instead of queueing forever", async () => {
  const lim = new Limiter(2);
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 20 }, () => lim.run(async () => {
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, 2));
    active--;
  })));
  assert.equal(peak, 2);
  assert.equal(lim.running, 0);
  const m = new Mutex(100);
  let secondRan = false;
  const first = m.lock(() => new Promise((r) => setTimeout(r, 300)));
  await assert.rejects(m.lock(async () => { secondRan = true; }), /busy/);
  await first;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(secondRan, false, "a call that gave up never runs later");
  assert.equal(await m.lock(async () => 7), 7, "the lock still works afterwards");
});
