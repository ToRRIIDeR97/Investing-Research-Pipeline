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
