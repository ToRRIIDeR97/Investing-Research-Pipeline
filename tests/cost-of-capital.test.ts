import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { StoredBar } from "@/lib/market-data/price-history";
import { stooqSymbol } from "@/lib/market-data/providers/stooq";
import {
  BETA_MIN_RETURNS, costOfCapitalInputs, equityRiskPremiumAt, regressionBeta, weekStart, weeklyCloses,
} from "@/lib/research/valuation/cost-of-capital";
import { systemAnswer, type TeamRequest } from "@/lib/research/team";

const DAY = 86_400_000;
function bar(day: string, close: number, extra: Partial<StoredBar> = {}): StoredBar {
  return { id: `bar-${day}`, day, close, adjusted_close: null, currency: "USD", provider_symbol: "TEST", retrieved_day: "2026-10-10",
    available_at: new Date(Date.parse(`${day}T00:00:00Z`) + DAY).toISOString(), verification_status: "unverified", verification_json: {}, ...extra };
}

/** One Friday bar per week ending on `lastFriday`; the stock's weekly return is 1.5 × the index's + 0.1%. */
function weeklySeries(weeks: number, lastFriday = "2026-10-09", status = "unverified") {
  const index: StoredBar[] = [], stock: StoredBar[] = [];
  let indexClose = 4000, stockClose = 100;
  for (let i = weeks - 1; i >= 0; i--) {
    const day = new Date(Date.parse(`${lastFriday}T00:00:00Z`) - i * 7 * DAY).toISOString().slice(0, 10);
    const r = 0.02 * Math.sin(i * 1.7) + 0.001;
    indexClose *= 1 + r;
    stockClose *= 1 + 1.5 * r + 0.001;
    index.push(bar(day, indexClose, { verification_status: status }));
    stock.push(bar(day, stockClose, { verification_status: status }));
  }
  return { index, stock };
}

describe("regression beta", () => {
  it("keys weeks by their Monday", () => {
    assert.equal(weekStart("2026-10-09"), "2026-10-05");
    assert.equal(weekStart("2026-10-05"), "2026-10-05");
    assert.equal(weekStart("2026-10-11"), "2026-10-05");
  });

  it("keeps each week's last close available by the cutoff", () => {
    const weeks = weeklyCloses([bar("2026-10-05", 10), bar("2026-10-07", 11), bar("2026-10-08", 99)], [], new Date("2026-10-08T12:00:00Z"));
    // 8 October's close is public only from 9 October.
    assert.deepEqual([...weeks], [["2026-10-05", { close: 11, verified: false }]]);
  });

  it("regresses weekly returns over two years and applies the Blume adjustment", () => {
    const { index, stock } = weeklySeries(150);
    // A bar after the cutoff never enters the window.
    const late = bar("2026-10-16", 1, { available_at: "2026-10-17T00:00:00.000Z" });
    const beta = regressionBeta({ symbol: "test", stock: { bars: [...stock, late], splits: [] },
      benchmark: { bars: index, splits: [] }, cutoffAt: new Date("2026-10-12T12:00:00Z") });
    assert.equal(beta.status, "computed");
    assert.equal(beta.raw_beta, 1.5);
    assert.equal(beta.adjusted_beta, 1.335);
    assert.equal(beta.value, 1.335);
    assert.equal(beta.r_squared, 1);
    assert.equal(beta.observations, 103);
    assert.equal(beta.window_end, "2026-10-05");
    assert.equal(beta.stock_symbol, "TEST");
    assert.equal(beta.benchmark.symbol, "^GSPC");
    assert.equal(beta.verified, false);
    assert.equal(beta.verification!.stock_verified_points, 0);
  });

  it("is verified only when every close in the window was cross-checked", () => {
    const { index, stock } = weeklySeries(110, "2026-10-09", "verified");
    const beta = regressionBeta({ symbol: "TEST", stock: { bars: stock, splits: [] }, benchmark: { bars: index, splits: [] }, cutoffAt: new Date("2026-10-12T00:00:00Z") });
    assert.equal(beta.verified, true);
  });

  it("is unavailable with too few overlapping weeks or no benchmark", () => {
    const { index, stock } = weeklySeries(BETA_MIN_RETURNS);
    const cutoffAt = new Date("2026-10-12T00:00:00Z");
    const short = regressionBeta({ symbol: "TEST", stock: { bars: stock, splits: [] }, benchmark: { bars: index, splits: [] }, cutoffAt });
    assert.equal(short.status, "unavailable");
    assert.equal(short.value, null);
    assert.match(short.reason!, /51 weekly returns/);
    const none = regressionBeta({ symbol: "TEST", stock: { bars: stock, splits: [] }, benchmark: { bars: [], splits: [] }, cutoffAt });
    assert.match(none.reason!, /No stored \^GSPC benchmark prices/);
  });
});

describe("equity risk premium and CAPM", () => {
  it("uses the latest year-end implied ERP public by the cutoff", () => {
    assert.equal(equityRiskPremiumAt(new Date("2026-01-10T00:00:00Z"))?.as_of, "2024-12-31");
    const erp = equityRiskPremiumAt(new Date("2026-10-08T00:00:00Z"))!;
    assert.deepEqual([erp.rate, erp.as_of, erp.available_at, erp.stale], [0.0423, "2025-12-31", "2026-01-15", false]);
    assert.match(erp.url, /histimpl\.html$/);
    assert.equal(equityRiskPremiumAt(new Date("2016-01-01T00:00:00Z")), null);
    assert.equal(equityRiskPremiumAt(new Date("2027-03-01T00:00:00Z"))?.stale, true);
  });

  it("builds the CAPM cost of equity and names unverified or missing inputs", () => {
    const { index, stock } = weeklySeries(150);
    const cutoffAt = new Date("2026-10-12T12:00:00Z");
    const beta = regressionBeta({ symbol: "TEST", stock: { bars: stock, splits: [] }, benchmark: { bars: index, splits: [] }, cutoffAt });
    const inputs = costOfCapitalInputs({ beta, riskFreeRate: { rate: 0.041, observation_date: "2026-10-09" }, cutoffAt });
    assert.equal(inputs.capm_cost_of_equity?.rate, Number((0.041 + 1.335 * 0.0423).toFixed(4)));
    assert.deepEqual(inputs.capm_cost_of_equity?.unverified_inputs, ["beta"]);
    assert.equal(inputs.gaps.length, 1);
    assert.match(inputs.gaps[0], /unverified/);
    const missing = costOfCapitalInputs({ beta: null, riskFreeRate: null, cutoffAt });
    assert.equal(missing.capm_cost_of_equity, null);
    assert.match(missing.gaps[0], /No regression beta/);
  });

  it("maps the benchmark to Stooq's S&P 500 symbol", () => {
    assert.equal(stooqSymbol("^GSPC"), "^spx");
  });
});

describe("beta research requests", () => {
  it("are answered from the captured market history", () => {
    const { index, stock } = weeklySeries(150);
    const cutoffAt = new Date("2026-10-12T12:00:00Z");
    const beta = regressionBeta({ symbol: "TEST", stock: { bars: stock, splits: [] }, benchmark: { bars: index, splits: [] }, cutoffAt });
    const request = { id: "request-1-3", role: "valuation", question: "Supply a documented beta source so the discount rate can be checked.",
      material: true, needs_sources: false, source_role: "market_data" } as TeamRequest;
    const answer = systemAnswer(request, {
      marketHistory: { id: "artifact-1", content: { bars_available: 700, market_data_cutoff: cutoffAt.toISOString(), beta } },
      fred: { sourceId: "fred-1", csv: "observation_date,DGS10\n2026-10-09,4.10\n" },
    })!;
    assert.equal(answer.resolved_by, "system:cost-of-capital");
    assert.deepEqual(answer.source_ids, ["fred-1"]);
    assert.match(answer.answer, /1\.335 adjusted/);
    assert.match(answer.answer, /0\.0423 as of 2025-12-31/);
    assert.match(answer.answer, /CAPM cost of equity 0\.0975/);
  });
});
