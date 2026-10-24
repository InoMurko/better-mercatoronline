import { test } from "node:test";
import assert from "node:assert/strict";
import { formatOrder, parseOrder } from "../src/app/order.ts";

test("weighed products (0,75 kg) round-trip", () => {
  const lines = [
    { name: "Rumene breskve, cena za kg", quantity: 0.75, unitPrice: 2.59 },
    { name: "Skyr, Active Zone, 500 g", quantity: 2, unitPrice: 1.69 },
  ];
  assert.deepEqual(parseOrder(formatOrder(lines)), lines);
  // files written before this fix used "0.75"
  assert.equal(parseOrder(formatOrder(lines).replace("0,75", "0.75"))[0].quantity, 0.75);
});
