// Analysis-stage packets are fitted to ANALYSIS_PACKET_BYTES so no call crosses the 100K-token long-prompt rate.
import test from "node:test";
import assert from "node:assert/strict";
import { ANALYSIS_PACKET_BYTES, ANALYSIS_PACKET_STAGES, PER_CALL_RESERVE_BYTES, fitAnalysisPacket, fitCallPacket, tabulateRows } from "../src/lib/research/call-packet";
import { finishCallPacket } from "../src/lib/research/run-context";

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const text = (bytes: number, seed = "x") => seed.repeat(bytes);
const claim = (i: number) => ({ id: `claim-${i}`, claim_text: `Claim ${i} ${text(300)}`, quote: text(400, "q") });
const artifact = (type: string, fields: Record<string, unknown>) => ({ id: `${type}-id`, artifact_type: type, artifact_version: 1, content_json: fields });
const stagePacket = (claims: number, extra: Record<string, unknown> = {}) => ({
  asset: { symbol: "SOFI" }, output_contract: "x", output_schema: { type: "object" },
  evidence_claims: Array.from({ length: claims }, (_, i) => claim(i)),
  team_context: { role: "business", upstream_artifacts: [artifact("segment_model", { summary: "kept", detail: text(20_000) })] },
  ...extra,
});

test("the analysis stages are capped; data and report stages fit their own packets", () => {
  for (const stage of ["asset_valuation", "decision_synthesis", "business_process_analysis", "moat_analysis", "company_genesis", "operating_model"])
    assert.ok(ANALYSIS_PACKET_STAGES.has(stage), stage);
  for (const stage of ["evidence_extraction", "report_draft", "ai_reviewer"]) assert.ok(!ANALYSIS_PACKET_STAGES.has(stage), stage);
});

test("a packet within the budget is returned unchanged, so small runs send what they always sent", () => {
  const packet = stagePacket(10);
  assert.equal(fitAnalysisPacket(packet), packet);
  assert.equal(fitCallPacket(packet, ["request"]), packet);
});

test("artifact fields are capped before any claim is touched, and the capped fields are named", () => {
  const packet = stagePacket(30);
  const fitted: any = fitAnalysisPacket(packet, size(packet) - 10_000);
  const segment = fitted.team_context.upstream_artifacts[0];
  assert.deepEqual(segment.omitted_fields, ["detail"]);
  assert.equal(segment.content_json.summary, "kept");
  assert.equal(fitted.evidence_claims.length, 30);
  assert.ok(fitted.evidence_claims.every((c: any) => c.quote));
  assert.ok(size(fitted) <= size(packet) - 10_000);
  assert.deepEqual(fitted.packet_cap, {});
});

test("then claims lose their quotes, then the lowest-ranked claims go, never below 20", () => {
  const packet = stagePacket(100);
  const noQuotes: any = fitAnalysisPacket(packet, size(packet) - 50_000);
  assert.equal(noQuotes.evidence_claims.length, 100);
  assert.ok(noQuotes.evidence_claims.every((c: any) => !("quote" in c) && c.claim_text));
  assert.equal(noQuotes.packet_cap.claim_quotes_omitted, true);

  const fewer: any = fitAnalysisPacket(packet, 25_000);
  assert.ok(size(fewer) <= 25_000);
  assert.ok(fewer.evidence_claims.length >= 20 && fewer.evidence_claims.length < 100);
  assert.deepEqual(fewer.evidence_claims.map((c: any) => c.id), packet.evidence_claims.slice(0, fewer.evidence_claims.length).map(c => c.id));
  assert.equal(fewer.packet_cap.omitted_claims, 100 - fewer.evidence_claims.length);
  // The most claims that fit: one more would not.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const oneMore = { ...fewer, evidence_claims: packet.evidence_claims.slice(0, fewer.evidence_claims.length + 1).map(({ quote, ...c }) => c) };
  assert.ok(size(oneMore) > 25_000);

  const floor: any = fitAnalysisPacket(packet, 5_000);
  assert.equal(floor.evidence_claims.length, 20);
});

test("past 20 claims the largest artifacts go, then the stage's own inputs are cut, each named", () => {
  const packet = stagePacket(20, { accepted_valuation: { valuation_scenario_set: { value_today_base: 12, method_schedules: text(30_000) } },
    recent_rows: Array.from({ length: 200 }, (_, i) => `row-${i}-${text(100)}`) });
  const fitted: any = fitAnalysisPacket(packet, 18_000);
  assert.ok(size(fitted) <= 18_000);
  assert.deepEqual(fitted.packet_cap.omitted_artifacts, ["segment_model"]);
  assert.ok(fitted.packet_cap.omitted_inputs.includes("accepted_valuation.valuation_scenario_set.method_schedules"));
  assert.equal(fitted.accepted_valuation.valuation_scenario_set.value_today_base, 12);
  assert.equal(fitted.output_schema.type, "object");
  assert.equal(fitted.asset.symbol, "SOFI");
});

test("an upstream artifact the stage already sends under its type name becomes a pointer", () => {
  const set = { value_today_base: 12, method_schedules: text(30_000) };
  const packet = stagePacket(10, { accepted_valuation: { valuation_scenario_set: set } });
  packet.team_context.upstream_artifacts.push(artifact("valuation_scenario_set", { ...set, older_version: true }));
  const fitted: any = fitAnalysisPacket(packet, size(packet) - 20_000);
  const pointer = fitted.team_context.upstream_artifacts.find((a: any) => a.artifact_type === "valuation_scenario_set");
  assert.equal(pointer.content_in, "accepted_valuation.valuation_scenario_set");
  assert.ok(!("content_json" in pointer));
  assert.equal(pointer.id, "valuation_scenario_set-id");
  assert.equal(fitted.accepted_valuation.valuation_scenario_set.method_schedules, set.method_schedules);
});

test("row arrays become tables without losing a value", () => {
  const rows = [{ period: "2025Q3", value: 1 }, { period: "2025Q4", value: 2 }, { period: "FY2025", value: 3 }];
  assert.deepEqual(tabulateRows({ revenue: rows, short: rows.slice(0, 2), mixed: [...rows, { other: 1 }] }), {
    revenue: { columns: ["period", "value"], rows: [["2025Q3", 1], ["2025Q4", 2], ["FY2025", 3]] },
    short: rows.slice(0, 2), mixed: [...rows, { other: 1 }],
  });
});

test("per-call keys stay out of the fit and last, so siblings share the capped prefix", () => {
  const base = { asset: { symbol: "SOFI" }, evidence: Array.from({ length: 500 }, (_, i) => claim(i)), role: "valuation" };
  const call = (question: string, passages: number) => ({ ...base, request: { question }, source_search_attempted: false, passages: text(passages) });
  const keys = ["request", "source_search_attempted", "passages"];
  const a: any = fitCallPacket(call("first", 1_000), keys);
  const b: any = fitCallPacket(call("second", 20_000), keys);
  const shared = (packet: any) => JSON.stringify(Object.fromEntries(Object.entries(packet).filter(([key]) => !keys.includes(key))));
  assert.equal(shared(a), shared(b));
  assert.deepEqual(Object.keys(a).slice(-3), keys);
  assert.ok(Buffer.byteLength(shared(a)) <= ANALYSIS_PACKET_BYTES - PER_CALL_RESERVE_BYTES);
  assert.ok(a.evidence.length < 500 && a.evidence.length >= 20);
});

test("finishCallPacket fits only when given a budget", () => {
  const packet = stagePacket(400);
  assert.ok(size(finishCallPacket(packet)) > ANALYSIS_PACKET_BYTES);
  const fitted: any = finishCallPacket(packet, undefined, undefined, ANALYSIS_PACKET_BYTES);
  assert.ok(size(fitted) <= ANALYSIS_PACKET_BYTES);
  assert.ok("packet_cap" in fitted);
});
