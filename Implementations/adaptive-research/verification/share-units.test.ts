import test from "node:test";
import assert from "node:assert/strict";
import { projectionSharesInMillions } from "../../../src/lib/research/valuation/share-denominator";

test("AC-L1: share units follow field definitions rather than guessing from magnitude", () => {
  assert.equal(projectionSharesInMillions({ diluted_shares: 10 }, 1), 0.00001);
  assert.equal(projectionSharesInMillions({ diluted_shares_millions: 10 }, 1), 10);
  assert.equal(projectionSharesInMillions({ shares_outstanding: 2_000_000 }, 1), 2);
});

test("AC-L1: supported book-value inference is preserved without filling a missing denominator", () => {
  assert.equal(projectionSharesInMillions({ equity_base: 1000, book_value_per_share_base: 10 }, 100), 100);
  assert.throws(() => projectionSharesInMillions({ equity_base: 1000, book_value_per_share_base: 0 }, 100), /positive.*share denominator/);
});
