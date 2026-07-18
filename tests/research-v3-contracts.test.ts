import { describe, it } from "node:test";
import assert from "node:assert";
import { createProfile, validateArchetypes, isBacktestApplicable } from "@/lib/research/pipeline-contracts";

describe("research v3 contracts", () => {
  it("C2-T1: Compose MELI archetypes", () => {
    const result = createProfile("meli-test", {
      asset_id: "meli",
      archetypes: [
        "operating_company_core",
        "marketplace",
        "payments_network",
        "lender",
        "logistics_network",
        "advertising_platform",
      ],
      overlays: ["emerging_market_multi_country"],
    });

    assert.ok(result.valid, result.errors.map((e) => e.message).join("; "));
    const artifacts = result.composed.required_artifacts.map((a) => a.artifact_type);
    assert.ok(artifacts.includes("company_genesis"));
    assert.ok(artifacts.includes("operating_scenario_set"));

    const roles = result.composed.source_roles.map((r) => r.role);
    assert.ok(roles.includes("regulatory_filing"));
    assert.ok(roles.includes("market_data"));
    assert.ok(roles.includes("macro_dataset"));

    const drivers = result.composed.required_scenario_drivers.map((d) => d.driver_key);
    assert.ok(drivers.includes("buyers"));
    assert.ok(drivers.includes("tpv"));
    assert.ok(drivers.includes("loan_origination"));
    assert.ok(drivers.includes("package_volume"));
    assert.ok(drivers.includes("ad_impressions"));
    assert.ok(drivers.includes("country_revenue_share"));
  });

  it("C2-T2: Compose a plain industrial company", () => {
    const result = createProfile("industrial-test", {
      asset_id: "industrial",
      archetypes: ["operating_company_core", "industrial_hardware"],
      overlays: [],
    });
    assert.ok(result.valid);
    const metrics = result.composed.historical_metrics.map((m) => m.metric_family);
    assert.ok(!metrics.includes("loan_portfolio"));
    assert.ok(!metrics.includes("gmv"));
    assert.ok(metrics.includes("orders_and_backlog"));
  });

  it("C2-T3: Compose conflicting valuation rules", () => {
    const result = createProfile("conflict-test", {
      asset_id: "conflict",
      archetypes: ["operating_company_core", "holding_company", "etf_fund"],
      overlays: [],
    });
    assert.ok(result.errors.some((e) => e.code === "conflict" && e.message.includes("Valuation method")));
  });

  it("C2-T4: Compose duplicate modules from two archetypes", () => {
    const result = createProfile("dup-test", {
      asset_id: "dup",
      archetypes: ["operating_company_core", "marketplace"],
      overlays: [],
    });
    assert.ok(result.valid);
    const artifacts = result.composed.required_artifacts;
    const counts = new Map<string, number>();
    for (const a of artifacts) {
      counts.set(a.artifact_type, (counts.get(a.artifact_type) ?? 0) + 1);
    }
    for (const [, count] of counts) {
      assert.equal(count, 1);
    }
  });

  it("C2-T5: No timing hypothesis means backtest not applicable", () => {
    const status = isBacktestApplicable(undefined);
    assert.equal(status, "not_applicable");
  });

  it("C2-T6: Explicit timing hypothesis accepted makes backtest eligible", () => {
    const status = isBacktestApplicable({
      hypothesis_text: "test",
      accepted: true,
      accepted_at: "2026-07-17",
      accepted_by: "test",
    });
    assert.equal(status, "pending");
  });

  it("C2-T7: No asset-slug branches in pipeline contracts", () => {
    const { readFileSync } = require("node:fs");
    const paths = [
      "src/lib/research/pipeline-contracts.ts",
      "src/lib/research/archetypes/registry.ts",
      "src/lib/research/archetypes/compose.ts",
      "src/lib/research/archetypes/types.ts",
    ];
    for (const p of paths) {
      const content = readFileSync(p, "utf8");
      assert.ok(!content.includes("mercado-libre"), `${p} contains mercado-libre`);
      assert.ok(!content.includes("sofi"), `${p} contains sofi`);
      assert.ok(!content.includes("deckers"), `${p} contains deckers`);
    }
  });
});
