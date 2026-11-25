// Quant colour tones (src/components/quant/tones.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { gradeTone } from "../src/components/quant/tones";

test("grade letters map to tones A green through F red, with modifiers ignored", () => {
  assert.deepEqual(["A+", "A", "A-", "B+", "B-", "C", "C-", "D", "F"].map(gradeTone), ["a", "a", "a", "b", "b", "c", "c", "d", "f"]);
  assert.equal(gradeTone(" b+ "), "b");
  assert.equal(gradeTone(null), "none");
  assert.equal(gradeTone(""), "none");
  assert.equal(gradeTone("N/A"), "none");
});

test("caseMeter spans today's price to the case value on a shared track", async () => {
  const { caseMeter } = await import("../src/components/quant/tones");
  const vals = [102.11, 142.15, 169.33];
  const bull = caseMeter(100.73, vals, 169.33)!;
  assert.equal(bull.tick, 0);
  assert.equal(Math.round(bull.left + bull.width), 100);
  const bear = caseMeter(100.73, vals, 102.11)!;
  assert.ok(bear.width >= 3, "a tiny gap still shows");
  const below = caseMeter(120, [90, 120, 150], 90)!;
  assert.equal(below.left, 0);
  assert.equal(Math.round(below.tick), 50);
  assert.equal(caseMeter(null, vals, 100), null);
  assert.equal(caseMeter(100, vals, null), null);
});
