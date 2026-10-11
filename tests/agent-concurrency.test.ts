import assert from "node:assert/strict";
import test from "node:test";
import { agentConcurrency, mapWithConcurrency } from "../src/lib/research/pipeline-helpers";
import { composeReviewedReport } from "../src/lib/research/reporting/compose";

const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));

test("the pool keeps input order, caps calls in flight and settles every item before rethrowing", async () => {
  let inFlight = 0, peak = 0;
  const finished: number[] = [];
  const result = await mapWithConcurrency([30, 5, 20, 1, 10, 2], async (ms, index) => {
    peak = Math.max(peak, ++inFlight);
    await tick(ms);
    inFlight--; finished.push(index);
    return ms * 10;
  }, 3);
  assert.deepEqual(result, [300, 50, 200, 10, 100, 20], "results by index, not by completion");
  assert.equal(peak, 3);
  assert.notDeepEqual(finished, [0, 1, 2, 3, 4, 5], "items really overlapped");

  const saved: number[] = [];
  await assert.rejects(mapWithConcurrency([1, 2, 3, 4, 5], async item => {
    await tick(item);
    if (item === 1) throw new Error("item 1 failed");
    saved.push(item);
  }, 2), /item 1 failed/);
  assert.deepEqual(saved.sort(), [2, 3, 4, 5], "the other items still finish before the failure is rethrown");

  assert.equal(agentConcurrency({}), 4);
  assert.equal(agentConcurrency({ RESEARCH_AGENT_CONCURRENCY: "1" }), 1);
  assert.equal(agentConcurrency({ RESEARCH_AGENT_CONCURRENCY: "0" }), 4);
  assert.equal(agentConcurrency({ RESEARCH_AGENT_CONCURRENCY: "2.5" }), 4);
});

const plan = (id: string, coverage: string[]) => ({ id, title: `Section ${id}`, purpose: "Explain", coverage, artifact_ids: [] });
const sectionFor = (p: ReturnType<typeof plan>, text = "Analysis.") => ({ ...p,
  paragraphs: [{ kind: "assumption", text, evidence_ids: [], artifact_ids: [] }],
  counterevidence: "None", implication: "Withhold", gaps: ["Fixture"], tables: [] });
// The opening summary is the conclusion; six body sections follow it in the outline.
const outline = { sections: [plan("summary", ["conclusion"]), ...["a", "b", "c", "d", "e", "f"].map(id => plan(id, [id === "a" ? "history" : "business"]))],
  questions: [], coverage: [{ key: "conclusion", ids: ["summary"] }, { key: "history", ids: ["a"] }, { key: "business", ids: ["b", "c", "d", "e", "f"] }]
    .map(({ key, ids }) => ({ key, status: "blocked", rationale: "Fixture", section_ids: ids })) };
const input = { asset_name: "Fixture", cutoff: "2026-01-01", is_test: true, artifacts: [], evidence: [], required_coverage: ["conclusion", "history", "business"] };

test("body sections are written four at a time; the conclusion follows them and reads them in outline order", async () => {
  let inFlight = 0, peak = 0;
  const order: string[] = [];
  let conclusionSaw: string[] = [];
  const result = await composeReviewedReport(input, {
    plan: async () => outline as any,
    write: async (p, _outline, _feedback, completed) => {
      if (p.coverage.includes("conclusion")) conclusionSaw = completed.map(s => s.id);
      else assert.deepEqual(completed, [], "body sections read no other section");
      peak = Math.max(peak, ++inFlight);
      await tick(p.id === "a" ? 30 : 5);
      inFlight--; order.push(p.id);
      return sectionFor(p as any) as any;
    },
    review: async () => ({ review_summary: "ok", findings: [], quality_score: 0.9, recommendations: [], review_verdict: "pass" }),
    save: async () => {},
  });
  assert.equal(peak, 4, "four body sections in flight at once");
  assert.equal(order.at(-1), "summary", "the conclusion is written after every body section");
  assert.deepEqual(conclusionSaw, ["a", "b", "c", "d", "e", "f"], "completed sections keep outline order, not finish order");
  assert.deepEqual(result.document.sections.map((s: any) => s.id), ["summary", "a", "b", "c", "d", "e", "f"]);
});

test("a failed body section is rethrown after the other sections are saved, and the conclusion is not written", async () => {
  const saved: string[] = [];
  let conclusionWritten = false;
  await assert.rejects(composeReviewedReport(input, {
    plan: async () => outline as any,
    write: async p => {
      if (p.coverage.includes("conclusion")) conclusionWritten = true;
      await tick(p.id === "b" ? 1 : 10);
      if (p.id === "b") throw new Error("section b failed");
      return sectionFor(p as any) as any;
    },
    review: async () => { throw new Error("must not review"); },
    save: async (type, scope) => { if (type === "report_section") saved.push(scope); },
  }), /section b failed/);
  assert.deepEqual(saved.sort(), ["a", "c", "d", "e", "f"]);
  assert.equal(conclusionWritten, false);
});

test("the writing repair rewrites affected body sections together, then the conclusion", async () => {
  let reviews = 0, inFlight = 0, peak = 0;
  const repaired: string[] = [];
  await composeReviewedReport(input, {
    plan: async () => outline as any,
    write: async (p, _outline, feedback, completed) => {
      peak = Math.max(peak, ++inFlight);
      await tick(5);
      inFlight--;
      if (feedback.length) {
        repaired.push(p.id);
        if (p.coverage.includes("conclusion")) assert.deepEqual(completed.filter(s => s.paragraphs[0].text === "Repaired.").map(s => s.id), ["b", "c", "d"]);
      }
      return sectionFor(p as any, feedback.length ? "Repaired." : "Draft.") as any;
    },
    review: async () => ++reviews === 1
      ? { review_summary: "fix", findings: ["b", "c", "d"].map(id => ({ section_id: id, category: "writing" })), quality_score: 0.3, recommendations: [], review_verdict: "needs_more_work" }
      : { review_summary: "ok", findings: [], quality_score: 0.9, recommendations: [], review_verdict: "pass" },
    save: async () => {},
  });
  assert.deepEqual(repaired.slice(0, 3).sort(), ["b", "c", "d"]);
  assert.equal(repaired.at(-1), "summary");
  assert.equal(repaired.length, 4, "unaffected body sections are kept");
  assert.ok(peak >= 3, "the affected body sections were rewritten together");
});
