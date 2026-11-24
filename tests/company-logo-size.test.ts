// Logo normalization (logoBox in src/components/company/logo-box.ts): every logo covers about the same area.
import assert from "node:assert/strict";
import { test } from "node:test";
import { logoBox } from "../src/components/company/logo-box";

test("a square logo gets 70% of the box; a wide one is wider but shorter, with about the same area", () => {
  assert.deepEqual(logoBox(48, 1), { width: 34, height: 34 });
  const wide = logoBox(48, 1.5);
  assert.ok(wide.width > 34 && wide.width <= 48 && wide.height < 34);
  assert.ok(Math.abs(wide.width * wide.height - 34 * 34) / (34 * 34) < 0.05, "same area while it fits");
  assert.deepEqual(logoBox(48, 3), { width: 48, height: 16 }, "a 3:1 wordmark is capped at the box width");
});

test("very wide or tall logos stay inside the box, and bad ratios fall back to square", () => {
  const long = logoBox(48, 10);
  assert.equal(long.width, 48);
  assert.ok(long.height < 10);
  const tall = logoBox(48, 0.2);
  assert.equal(tall.height, 48);
  assert.deepEqual(logoBox(48, 0), logoBox(48, 1));
  assert.deepEqual(logoBox(48, Number.NaN), logoBox(48, 1));
});

test("maxWidth lets a wordmark run wider than the square, same area while it fits", () => {
  const wide = logoBox(44, 3.75, 96);
  assert.ok(wide.width > 44 && wide.width <= 96, `width ${wide.width}`);
  assert.ok(Math.abs(wide.width * wide.height - 31 * 31) / (31 * 31) < 0.1);
  assert.deepEqual(logoBox(44, 1, 96), logoBox(44, 1), "square logos are unchanged");
});
