import test from "node:test";
import assert from "node:assert/strict";
import { projectionSharesInMillions } from "../../../src/lib/research/valuation/share-denominator";

test("AC-L1: live raw share counts and explicit millions resolve to the same denominator", () => {
  assert.equal(projectionSharesInMillions({ diluted_shares: 1_351_990_000 }, 1351.99), 1351.99);
  assert.equal(projectionSharesInMillions({ diluted_shares_millions: 1351.99 }, 1351.99), 1351.99);
  assert.equal(projectionSharesInMillions({ shares_outstanding_millions: 1400 }, 1351.99), 1400);
});

test("AC-L1: missing or invalid denominators cannot become valuation inputs", () => {
  for (const balance of [{}, { diluted_shares: 0 }, { diluted_shares: -1 }, { diluted_shares_millions: Infinity }]) {
    assert.throws(() => projectionSharesInMillions(balance, 1351.99), /positive.*share denominator/);
  }
});
