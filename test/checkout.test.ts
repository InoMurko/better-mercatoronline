import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReview, reviewProblem } from "../src/shop/checkout.ts";

// text of the real review page (23.10.2026), name/address replaced
const page = `Pregled košarice
Izbira prevzema
Izbira plačila
Pregled in potrditev
Pregled in potrditev vašega naročila št.1000003
Mleto mešano meso, Mercator, pakirano, 450 g
1 Kos
3,49 EUR

Napotki za dostavo

Morebitni vpisani izdelki ne bodo obravnavani kot naročilo.

Prevzem izdelkov

Naslov za dostavo
NAME
STREET
CITY

Datum in čas dostave
24. oktober 2026 , med 08:00 in 10:00

Izbrani načini plačila
Ob prevzemu z gotovino:	10,49 EUR

Vrednost izdelkov:	3,49 EUR
Cena dostave:	7,00 EUR
*Skupaj za plačilo:	10,49 EUR

* Vrednost za plačilo je informativna.
Strinjam se s pogoji poslovanja .
POTRDI NAROČILO`;

test("review page", () => {
  assert.deepEqual(parseReview(page), {
    orderNo: "1000003",
    when: "24. oktober 2026, med 08:00 in 10:00",
    payment: "Ob prevzemu z gotovino: 10,49 EUR",
    total: 10.49,
    productsValue: 3.49,
    delivery: 7,
    items: 1,
    lines: ["Mleto mešano meso, Mercator, pakirano, 450 g | 1 Kos | 3,49 EUR"],
  });
});

test("confirm check: refuses changed items, missing fields, or a different payment", () => {
  const ok = parseReview(page);
  assert.equal(reviewProblem(ok, ok, "offlineCash"), null);
  const swapped = parseReview(page.replace("Mleto mešano meso", "Telečji zrezki"));
  assert.match(reviewProblem(swapped, ok, "offlineCash")!, /products changed/);
  const noWhen = parseReview(page.replace("Datum in čas dostave", "X"));
  assert.match(reviewProblem(noWhen, noWhen, "offlineCash")!, /couldn't read/);
  assert.match(reviewProblem(ok, ok, "offlineCard")!, /cash on delivery, not card on delivery/);
  const online = parseReview(page.replace("Ob prevzemu z gotovino", "Spletno plačilo s kartico"));
  assert.match(reviewProblem(online, online, "offlineCard")!, /isn't pay-on-delivery/);
});

test("no total → refuse (never confirm blind)", () => {
  assert.throws(() => parseReview("Pregled in potrditev\nPOTRDI NAROČILO"));
});
