import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOffers, priceLine } from "../src/app/offers.ts";

test("parse Mercator's discount data", () => {
  const o = parseOffers([
    { group_type: "discount", value: "", marker_code: "100", hover_text: "Ob nakupu 2 izdelkov ali več je vsak 50%" },
    { group_type: "discount", value: "1+1", marker_code: "101", hover_text: "Ob nakupu 1 izdelka, vam enega podarimo." },
    { group_type: "pika_discount", value: "-40", marker_code: "104" },
    { group_type: "other", value: "", marker_code: "123", hover_text: "Izbrana kakovost" },
  ]);
  assert.deepEqual(o.map((x) => x.kind), ["multi", "free", "info"]);
  assert.deepEqual(o[0], { kind: "multi", minQty: 2, percent: 50, coupon: undefined, label: "buy 2+ → −50 % each" });
  assert.equal(o[2].label, "Pika -40 %");
});

test("your toilet paper: 2 for the price of 1 (each −50 % when buying 2+)", () => {
  const tp = { price: 5.79, offers: parseOffers([{ hover_text: "Ob nakupu 2 izdelkov ali več je vsak 50%" }]) };
  assert.equal(priceLine(tp, 1).final, 5.79);
  assert.match(priceLine(tp, 1).notes[0], /buy 2\+/);
  assert.equal(priceLine(tp, 2).final, 5.79);
  assert.equal(priceLine(tp, 2).regular, 11.58);
});

test("straight discount is already in the price; regular price shows the saving", () => {
  const oil = { price: 1.85, regularPrice: 2.99, offers: [] };
  assert.deepEqual([priceLine(oil, 2).final, priceLine(oil, 2).regular], [3.7, 5.98]);
});

test("1+1: same money, twice the pieces; coupon offers only noted", () => {
  const p = { price: 4.79, offers: parseOffers([{ value: "1+1" }]) };
  assert.deepEqual([priceLine(p, 1).final, priceLine(p, 1).pieces], [4.79, 2]);
  const c = { price: 1.79, offers: parseOffers([{ value: "1+1", coupon: "C-1KK6MA08" }]) };
  assert.equal(priceLine(c, 1).pieces, 1);
  assert.match(priceLine(c, 1).notes[0], /coupon/);
});
