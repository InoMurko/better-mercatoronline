import { test } from "node:test";
import assert from "node:assert/strict";
import { readForm, setFields } from "../src/core/forms.ts";
import { pageText } from "../src/core/text.ts";
import { loggedInFlag } from "../src/shop/auth.ts";
import { parseMiniCart } from "../src/shop/cart.ts";
import { parseReview, parseTimetable } from "../src/shop/checkout.ts";
import { toProduct } from "../src/shop/products.ts";

// shapes as seen on mercatoronline.si, 23. 10. 2026 (personal data left out)
test("login form: all hidden fields kept, credentials set, button not sent", () => {
  const html = `<form><input type="search" name="search-string"></form>
  <form action="https://profil.mercator.si/sign-in.aspx?RETURNURI=x&LOGINCODE=MIT" method="post">
    <input type="hidden" name="btnLogin" value="test"><input type="hidden" name="POSTURI" value="https://mercatoronline.si/sso/">
    <input type="hidden" name="storeId" value="4040"><input type="text" name="txtUserName"><input type="password" name="txtPassword">
    <input type="checkbox" name="chkRememberMe"><button type="submit">Prijavite se</button></form>`;
  const f = readForm(html, "https://mercatoronline.si/prijava", (form) => !!form.querySelector('input[name="txtPassword"]'))!;
  assert.equal(f.method, "POST");
  assert.match(f.action, /^https:\/\/profil\.mercator\.si\/sign-in\.aspx/);
  const fields = Object.fromEntries(setFields(f.fields, { txtUserName: "me@x.si", txtPassword: "pw", chkRememberMe: "on" }));
  assert.deepEqual(fields, { btnLogin: "test", POSTURI: "https://mercatoronline.si/sso/", storeId: "4040", txtUserName: "me@x.si", txtPassword: "pw", chkRememberMe: "on" });
});

test("logged-in flag from the page script", () => {
  assert.equal(loggedInFlag("<script>ShopLib.loggedIn = true;</script>"), true);
  assert.equal(loggedInFlag("ShopLib.loggedIn = false;"), false);
  assert.equal(loggedInFlag("<p>nothing</p>"), null);
});

test("mini-cart lines (checkCartStatus / add responses)", () => {
  const html = `<div class="hidden"><span class="lib-cart-items-count"> 31 </span></div>
  <li class="lib-cart" data-item-id="13421936" data-item-code="00676780" data-quantity="2.00" data-gtin="38503924" data-position-id="33089802">
    <a href="/izdelek/13421936/puding" class="product-image"><img alt="Puding s čokolado in lešniki, Vindija, 125 g"></a>
    <h4 class="product-name"><strong> 2 kos </strong> - <a class="lib-cart-productName" href="/izdelek/13421936/puding" title="Puding s čokolado in lešniki, Vindija, 125 g"> Puding s čokolado in lešniki, Vindija, 125 g </a></h4>
    <div class="product-price"><span class="price">0,98 EUR</span><span class="price-per-unit">3,92 EUR / 1kg</span></div></li>`;
  const { count, lines } = parseMiniCart(html);
  assert.equal(count, 31);
  assert.deepEqual(lines[0], {
    itemId: "13421936", positionId: "33089802", gtin: "38503924", name: "Puding s čokolado in lešniki, Vindija, 125 g",
    quantity: 2, lineTotal: 0.98, url: "/izdelek/13421936/puding",
  });
});

test("search result → Product", () => {
  const p = toProduct({
    type: "product", itemId: "36375", url: "/izdelek/36375/x",
    data: { name: "Energijski napitek, Red Bull, 250 ml", current_price: "1.85", normal_price: "2.99", price_per_unit: 7.4, price_per_unit_base: "1l",
      brand_name: "RED BULL", category2: "PIJAČE", category3: "ENERGIJSKI", gtins: [{ gtin: "9002490100070" }],
      discounts: [{ group_type: "discount", value: "-38", hover_text: "" }] },
  })!;
  assert.equal(p.regularPrice, 2.99);
  assert.equal(p.gtin, "9002490100070");
  assert.equal(p.category, "PIJAČE > ENERGIJSKI");
  assert.equal(toProduct({ type: "banner" }), null);
});

test("delivery timetable: free cells only, with day, time, fee and the radio value", () => {
  const html = `<table><thead><tr><th></th><th>Petek 23. oktober</th><th>Sobota 24. oktober</th></tr></thead><tbody>
    <tr><td>08:00 - 10:00</td><td>Termin ni na voljo</td><td><input type="radio" name="radioTimetableDistributing" value="2026-10-24#08:00#10:00" granulation="2"> Prosto 7,00 EUR</td></tr>
    <tr><td>10:00 - 12:00</td><td><input type="radio" disabled value="x"> Termin ni na voljo</td><td><input type="radio" name="radioTimetableDistributing" value="2026-10-24#10:00#12:00" granulation="2"> Prosto 0,00 EUR</td></tr>
  </tbody></table>`;
  assert.deepEqual(parseTimetable(html), [
    { value: "2026-10-24#08:00#10:00", granulation: "2", day: "Sobota 24. oktober", time: "08:00 - 10:00", price: 7 },
    { value: "2026-10-24#10:00#12:00", granulation: "2", day: "Sobota 24. oktober", time: "10:00 - 12:00", price: 0 },
  ]);
});

test("review page from raw HTML (pageText keeps the line structure parseReview needs)", () => {
  const html = `<div id="main"><h3>Pregled in potrditev vašega naročila št.1000003</h3>
    <table><tr><td>Mleto mešano meso, Mercator, pakirano, 450 g</td></tr><tr><td>1 Kos</td><td>3,49 EUR</td></tr></table>
    <h4>Datum in čas dostave</h4><p>24. oktober 2026 , med 08:00 in 10:00</p>
    <h4>Izbrani načini plačila</h4><table><tr><td>Ob prevzemu z gotovino:</td><td>10,49 EUR</td></tr></table>
    <table><tr><td>Vrednost izdelkov:</td><td>3,49 EUR</td></tr><tr><td>Cena dostave:</td><td>7,00 EUR</td></tr><tr><td>*Skupaj za plačilo:</td><td>10,49 EUR</td></tr></table>
    <form action="/blagajna/potrdi-narocilo" method="post"><textarea name="note"></textarea><input type="checkbox" name="confirm-terms"></form></div>`;
  const r = parseReview(pageText(html));
  assert.deepEqual([r.orderNo, r.when, r.total, r.productsValue, r.delivery, r.items], ["1000003", "24. oktober 2026, med 08:00 in 10:00", 10.49, 3.49, 7, 1]);
  assert.match(r.payment, /Ob prevzemu z gotovino/);
  const f = readForm(html, "https://mercatoronline.si/blagajna/pregled-in-potrditev", 'input[name="confirm-terms"]')!;
  assert.equal(f.action, "https://mercatoronline.si/blagajna/potrdi-narocilo");
  assert.deepEqual(Object.fromEntries(setFields(f.fields, { "confirm-terms": "on" })), { note: "", "confirm-terms": "on" });
});

test("listing cache stays bounded however many different searches run", async () => {
  const { listing, cacheSize, CACHE_MAX } = await import("../src/shop/products.ts");
  const fake = { json: async () => ({ products: [] }) } as any;
  for (let i = 0; i < CACHE_MAX + 150; i++) await listing(fake, { search: `q${i}` });
  assert.ok(cacheSize() <= CACHE_MAX, `cache ${cacheSize()}`);
});

test("old data files get owner-only permissions", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, statSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { securePrivateFiles } = await import("../src/core/files.ts");
  const dir = mkdtempSync(join(tmpdir(), "merc-files-"));
  writeFileSync(join(dir, "history.json"), "[]", { mode: 0o644 });
  mkdirSync(join(dir, "orders"), { mode: 0o755 });
  writeFileSync(join(dir, "orders", "2026-01-01-1.txt"), "x", { mode: 0o644 });
  assert.equal(securePrivateFiles(dir), 3);
  assert.equal(statSync(join(dir, "history.json")).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "orders")).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, "orders", "2026-01-01-1.txt")).mode & 0o777, 0o600);
  assert.equal(securePrivateFiles(dir), 0, "idempotent");
});
