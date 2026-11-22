// A conclusion's model-written key_reasons: contract, storage, citation filtering, cleaning, substance and report hash.
import test from "node:test";
import assert from "node:assert/strict";
import { SECTION_CONTRACT, WrittenSectionAnswer, ConclusionSectionAnswer, storedSection, type ReportOutline, type ReportSection, type WriterSection } from "../src/lib/research/reporting/contracts";
import { CONCLUSION_CONTRACT, CONCLUSION_SECTION_CONTRACT, KEY_REASONS_RULE, PLAIN_LANGUAGE_RULE, includeFramingQuestions, keepUsableReferences, reportSectionCall } from "../src/lib/research/reporting/runtime";
import { cleanReaderFields, withoutThousands } from "../src/lib/research/reporting/reader-prose";
import { checkReportSubstance } from "../src/lib/research/reporting/substance";
import { createReport, type ReportInput } from "../src/lib/research/reporting/report";
import { contractJsonSchema } from "../src/lib/research/contract-json-schema";
import { anthropicWireSchema } from "../src/lib/agent-harness/providers/anthropic-schema";
import { z } from "zod/v4";

const reason = (headline: string, evidence_ids: string[] = ["ev-1"]) => ({ headline, explanation: "Capital is well above the minimum.", figure: "16.9% CET1", evidence_ids });
const written = (coverage: string[], extra: Record<string, unknown> = {}) => ({ id: coverage[0], title: "Judgment", purpose: "p", coverage, artifact_ids: [],
  paragraphs: [{ kind: "analysis" as const, text: "Capital ratios rose to 16.9% in 2025.", evidence_ids: ["ev-1"], artifact_ids: [] }],
  counterevidence: "Credit losses could rise.", implication: "The bank can absorb a downturn.", gaps: [], ...extra });

test("the conclusion contracts accept key_reasons; the body contract is unchanged", () => {
  const withReasons = written(["conclusion"], { key_reasons: [reason("Capital is strong."), reason("b"), reason("c"), reason("d")] });
  assert.deepEqual(CONCLUSION_CONTRACT.validate!({ section: withReasons, coverage: [] }), [], "a fourth reason costs no repair");
  assert.deepEqual(CONCLUSION_SECTION_CONTRACT.validate!({ section: withReasons }), []);
  assert.deepEqual(CONCLUSION_CONTRACT.requiredKeys, ["section", "coverage"]);
  assert.deepEqual(CONCLUSION_SECTION_CONTRACT.requiredKeys, ["section"]);
  assert.ok(CONCLUSION_CONTRACT.validate!({ section: written(["conclusion"], { key_reasons: [{ headline: "x" }] }), coverage: [] }).length, "an incomplete reason is rejected");
  // SECTION_CONTRACT still describes WrittenSectionAnswer, with no key_reasons property.
  assert.deepEqual(SECTION_CONTRACT.schema, contractJsonSchema(z.object({ section: WrittenSectionAnswer }), { target: "draft-7", io: "input" }));
  assert.ok(!JSON.stringify(SECTION_CONTRACT.schema).includes("key_reasons"));
  assert.ok(JSON.stringify(CONCLUSION_CONTRACT.schema).includes("key_reasons"));
  assert.ok("key_reasons" in ConclusionSectionAnswer.shape);
});

test("the Anthropic wire schema of both conclusion contracts stays within the structured-output limits", () => {
  for (const contract of [CONCLUSION_CONTRACT, CONCLUSION_SECTION_CONTRACT]) {
    const wire = anthropicWireSchema(contract.schema as Record<string, unknown>);
    assert.ok("schema" in wire, JSON.stringify(wire));
  }
});

test("a non-last conclusion gets CONCLUSION_SECTION_CONTRACT; body prompts get no key-reason rules", () => {
  const plan = (id: string, coverage: string[]) => ({ id, title: id, purpose: "p", coverage, artifact_ids: [] });
  const outline: ReportOutline = { sections: [plan("summary", ["conclusion"]), plan("business", ["business"]), plan("closing", ["conclusion", "monitoring"])],
    coverage: [{ key: "conclusion", status: "qualified", rationale: "r", section_ids: ["summary"] }], questions: [] };
  const common = { evidence_claims: [{ id: "ev-1" }] };
  const first = reportSectionCall(common, [], outline.sections[0], outline, [], []);
  const last = reportSectionCall(common, [], outline.sections[2], outline, [], [], outline.coverage);
  const body = reportSectionCall(common, [], outline.sections[1], outline, [], []);
  assert.equal(first.contract, CONCLUSION_SECTION_CONTRACT);
  assert.equal(last.contract, CONCLUSION_CONTRACT);
  assert.equal(body.contract, SECTION_CONTRACT);
  for (const call of [first, last]) assert.ok(call.extraRules.includes(KEY_REASONS_RULE) && call.extraRules.includes(PLAIN_LANGUAGE_RULE));
  assert.ok(!body.extraRules.includes(KEY_REASONS_RULE) && !body.extraRules.includes(PLAIN_LANGUAGE_RULE));
});

test("storedSection keeps at most three key_reasons, only on a conclusion; other sections store as before", () => {
  const reasons = [reason("a"), { ...reason(""), headline: " " }, reason("b"), reason("c"), reason("d")];
  const conclusion = storedSection(written(["conclusion"], { key_reasons: reasons }) as WriterSection, []);
  assert.deepEqual(conclusion.key_reasons!.map(r => r.headline), ["a", "b", "c"]);
  const plain = written(["business"]);
  const before = JSON.stringify({ ...plain, tables: [], exhibits: ["k"] });
  assert.equal(JSON.stringify(storedSection(plain as WriterSection, ["k"])), before);
  assert.equal(JSON.stringify(storedSection({ ...plain, key_reasons: reasons } as WriterSection, ["k"])), before, "a body section drops key_reasons");
  assert.ok(!("key_reasons" in storedSection(written(["conclusion"]) as WriterSection, [])));
  assert.ok(!("key_reasons" in storedSection(written(["conclusion"], { key_reasons: [] }) as WriterSection, [])));
});

test("keepUsableReferences drops unknown evidence inside key_reasons", () => {
  const dropped = new Set<string>();
  const value = { section: written(["conclusion"], { key_reasons: [reason("a", ["ev-1", "ev-x"])] }) as ReturnType<typeof written> & { key_reasons: ReturnType<typeof reason>[] } };
  const kept = keepUsableReferences(value, [], [{ id: "ev-1" }], dropped);
  assert.deepEqual(kept.section.key_reasons[0].evidence_ids, ["ev-1"]);
  assert.deepEqual([...dropped], ["ev-x"]);
});

test("cleanReaderFields cleans key_reasons and rewrites amounts in thousands", () => {
  const value: { section: Record<string, any> } = { section: written(["conclusion"], {
    implication: "Deposits reached 240,989 thousand and assets 9,520,479 thousand.",
    key_reasons: [{ headline: "The cet1_ratio is strong (ev1).", explanation: "Fees were 512 thousand.", figure: "$240,989 thousand", evidence_ids: ["ev1"] }] }) };
  const out = cleanReaderFields(value);
  assert.equal(out.section.implication, "Deposits reached 241.0 million and assets 9.52 billion.");
  assert.deepEqual(out.section.key_reasons[0], { headline: "The cet1 ratio is strong.", explanation: "Fees were 512,000.", figure: "$241.0 million", evidence_ids: ["ev1"] });
  assert.equal(withoutThousands("999,999.95 thousand"), "1.00 billion");
  assert.equal(withoutThousands("1,500.5 thousand units and thousandths"), "1.5 million units and thousandths");
  const once = withoutThousands("Revenue of 42,100 thousand rose 3%.");
  assert.equal(withoutThousands(once), once);
});

test("checkReportSubstance flags falsifier and scans key_reasons", () => {
  const section = { ...written(["conclusion"]), tables: [], key_reasons: [reason("The falsifier did not trigger.")] } as ReportSection;
  const findings = checkReportSubstance([section]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].issue, "The key reason 1 headline uses internal pipeline terms (falsifier).");
  assert.equal(checkReportSubstance([{ ...section, key_reasons: [{ ...reason("ok"), figure: "capital_ratio 16.9%" }] }])[0].issue,
    "The key reason 1 figure uses internal pipeline terms (field name).");
  assert.equal(checkReportSubstance([{ ...section, key_reasons: [] }]).length, 0);
  // Only conclusions are told to avoid "falsifier", so a body chapter using it is not sent to a paid rewrite.
  const body = { ...written(["valuation"]), tables: [], paragraphs: [{ kind: "fact", text: "The deposit-cost falsifier was 2.5% in 2025.", evidence_ids: ["e1"], artifact_ids: [] }] } as ReportSection;
  assert.equal(checkReportSubstance([body]).length, 0);
  assert.equal(checkReportSubstance([{ ...body, coverage: ["conclusion"] }])[0].issue, "The paragraph 1 uses internal pipeline terms (falsifier).");
});

test("a framing question left out of the outline asks what would disprove it, not for its falsifier", () => {
  const outline: ReportOutline = { sections: [], coverage: [], questions: [] };
  const [q] = includeFramingQuestions(outline, { key_questions: [{ id: "q", question: "Does it convert?", falsifier: "FCF below 50% of net income." }] }).questions;
  assert.equal(q.follow_up, "Test what would disprove it: FCF below 50% of net income.");
});

const evidence = (id: string) => ({ id, claim_text: `Claim ${id}`, source_title: `Filing ${id}`, url: `https://example.com/${id}`, published_at: "2025-01-01", location: "p. 1", quote: `Quote ${id}` });
const reportInput = (sections: ReportSection[]): ReportInput => ({ asset_name: "Bank", cutoff: "2025-06-30T00:00:00.000Z", is_test: true, required_coverage: ["conclusion"],
  sections, coverage: [{ key: "conclusion", status: "satisfied", rationale: "Done.", section_ids: ["conclusion"] }], questions: [],
  evidence: [evidence("ev-1"), evidence("ev-2")], artifacts: [] });
const conclusionSection = (extra: Record<string, unknown> = {}) => ({ ...written(["conclusion"]), tables: [], exhibits: [], ...extra }) as ReportSection;

test("createReport: a document without key_reasons hashes as before; evidence cited only by key_reasons joins Sources", () => {
  const plain = createReport(reportInput([conclusionSection()]));
  // The hash this fixture rendered to before key_reasons existed (computed with the code at commit 43441ae).
  assert.equal(plain.content_hash, "6308b39c23ebdffb29649f38c14b9cf69f6385c02979584491ffe038e245c7d5");
  assert.ok(!plain.markdown.includes("Quote ev-2"));
  assert.ok(!("key_reasons" in plain.sections[0]));
  const withReasons = createReport(reportInput([conclusionSection({ key_reasons: [reason("Capital is strong.", ["ev-2"])] })]));
  assert.ok(!withReasons.markdown.includes("Capital is strong."), "key_reasons are not rendered");
  assert.match(withReasons.markdown, /\[2\] \[Filing ev-2\]/);
  assert.match(withReasons.markdown, /Supporting passage: Quote ev-2/);
  assert.equal(withReasons.markdown.replace(/\n\[2\][^\n]*\n\nSupporting passage: Quote ev-2\n/, ""), plain.markdown, "the rest of the report is unchanged");
  assert.deepEqual(withReasons.sections[0].key_reasons, [reason("Capital is strong.", ["ev-2"])]);
  assert.ok(withReasons.evidence.some(e => e.id === "ev-2" && e.quote === "Quote ev-2"));
  assert.equal(createReport(JSON.parse(JSON.stringify(withReasons))).content_hash, withReasons.content_hash, "a stored report re-renders to its hash");
  assert.throws(() => createReport(reportInput([conclusionSection({ key_reasons: [reason("x", ["ev-missing"])] })])), /Unknown evidence ev-missing/);
});
