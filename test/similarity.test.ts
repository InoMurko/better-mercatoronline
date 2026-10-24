import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { attributes, rankSimilar } from "../src/app/similarity.ts";
import type { Product } from "../src/shop/products.ts";

const paper: Product[] = JSON.parse(readFileSync(new URL("./fixtures/toaletni-papir.json", import.meta.url), "utf8"));
const without = (name: string) => paper.filter((p) => p.name !== name);
const byName = (name: string) => paper.find((p) => p.name === name)!;

test("attributes", () => {
  assert.deepEqual(attributes("Toaletni papir Strong & Soft, breskev, Violeta, 3 slonji, 10/1"), { ply: 3, percents: [], size: null, pack: 10 });
  assert.deepEqual(attributes("Trajno mleko, 3,5 % m.m., Mila, 1 l"), { ply: null, percents: [3.5], size: 1000, pack: null });
  assert.equal(attributes("Pivo Bevog Tak pale ale, 5,5 % alkohola, 0,33 l").size, 330);
});

test("wet toilet paper is replaced by wet toilet paper, not rolls", () => {
  const ref = byName("Vlažni toaletni papir Hemo care, Violeta, 60/1");
  const ranked = rankSimilar(ref, without(ref.name));
  console.log(ranked.slice(0, 4).map((r) => `${r.score}  ${r.product.name}  [${r.reasons.join("; ")}]`).join("\n"));
  assert.match(ranked[0].product.name, /vlažni/i);
  assert.match(ranked[1].product.name, /vlažni/i);
});

test("premium 3-ply rolls → similar-quality 3-ply, not the cheapest", () => {
  const ref = byName("Toaletni papir Premium, Violeta, 3-slojni, 10 rolic");
  const ranked = rankSimilar(ref, without(ref.name));
  console.log(ranked.slice(0, 4).map((r) => `${r.score}  ${r.product.name}  [${r.reasons.join("; ")}]`).join("\n"));
  const top = ranked[0].product;
  assert.doesNotMatch(top.name, /vlažni/i);
  assert.equal(attributes(top.name).ply, 3);
  assert.ok(top.unitPrice! >= 0.35, `picked a cheap one: ${top.name}`);
});

const p = (name: string, price: number, unitPrice: number, category: string, brand: string): Product => ({
  id: name, name, price, unitPrice, unitBase: "1l", brand, category: `MLEKO > ${category}`, url: "",
});
test("milk keeps its fat % and type", () => {
  const ref = p("Trajno mleko, 3,5 % m.m., Alpsko, 1 l", 1.29, 1.29, "TRAJNO MLEKO", "ALPSKO");
  const cands = [
    p("Trajno mleko, 1,5 % m.m. Mila, 1 l", 0.79, 0.79, "TRAJNO MLEKO", "MILA"),
    p("Trajno mleko, 3,5 % m.m., Mila, 1 l", 0.89, 0.89, "TRAJNO MLEKO", "MILA"),
    p("Sveže mleko, 3,5 % m.m., Ljubljanske mlekarne, 1 l", 1.19, 1.19, "SVEŽE MLEKO", "LJUBLJANSKE MLEKARNE"),
    p("Trajno mleko, 3,5 % m.m., Mercator, 1 l", 0.99, 0.99, "TRAJNO MLEKO", "MERCATOR"),
    p("Trajno mleko, 1,5 % m.m., Alpsko, 1 l", 1.19, 1.19, "TRAJNO MLEKO", "ALPSKO"),
  ];
  const ranked = rankSimilar(ref, cands);
  console.log(ranked.map((r) => `${r.score}  ${r.product.name}  [${r.reasons.join("; ")}]`).join("\n"));
  assert.match(ranked[0].product.name, /^Trajno mleko, 3,5/);
  assert.ok(!/1,5/.test(ranked[0].product.name));
});

test("yoghurt keeps its type (skyr ≠ greek ≠ natural)", () => {
  const y = (name: string, price: number, unitPrice: number, brand: string): Product => ({
    id: name, name, price, unitPrice, unitBase: "1kg", brand, category: "KISLO MLEKO, JOGURTI IN MLEČNI NAPITKI > NAVADNI JOGURTI", url: "",
  });
  const ref = y("Skyr, Active Zone, 500 g", 1.69, 3.38, "ACTIVE ZONE");
  const cands = [
    y("Grški jogurt, 10 % m.m., Olympus, 500 g", 3.49, 6.98, "OLYMPUS"),
    y("Navadni jogurt, 3,2 % m.m., Ljubljanske mlekarne, 500 g", 1.19, 2.38, "LJUBLJANSKE MLEKARNE"),
    y("Skyr natural, Arla, 450 g", 2.29, 5.09, "ARLA"),
    y("Jogurt grškega tipa, Mercator, 500 g", 1.49, 2.98, "MERCATOR"),
  ];
  const ranked = rankSimilar(ref, cands);
  console.log(ranked.map((r) => `${r.score}  ${r.product.name}  [${r.reasons.join("; ")}]`).join("\n"));
  assert.match(ranked[0].product.name, /skyr/i);
});
