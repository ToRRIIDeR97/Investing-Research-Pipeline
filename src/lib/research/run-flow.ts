/**
 * The guided run flow (workshop prototype/workshop/run-flow, variant A with B, C and D elements): the five steps a
 * person goes through, the 25 stages grouped into five phases, plain-words progress, estimates from past runs, and
 * what is waiting on the person. Pure and client-safe; the pages and `/api/research-runs/estimates` use it.
 */
import { STAGE_CONFIGS } from "@/lib/workflow/stages";

export interface FlowStage { key: string; status: string; started_at?: string | null; completed_at?: string | null }

/** The five steps of the flow, in order. */
export const FLOW_STEPS = [
  { key: "company", label: "Company" },
  { key: "question", label: "Question" },
  { key: "plan", label: "Plan" },
  { key: "research", label: "Research" },
  { key: "review", label: "Review" },
] as const;
export type FlowStepKey = (typeof FLOW_STEPS)[number]["key"];

export interface RunPhase { key: string; label: string; blurb: string; stages: readonly string[]; gate?: "plan" | "review" }

/** The pipeline's stages in five phases, in stage order. Frame ends at the plan gate; Decide holds the final review. */
export const RUN_PHASES: readonly RunPhase[] = [
  { key: "frame", label: "Frame", blurb: "Question, identity and plan", stages: ["intake", "asset_identity", "archetype_composition", "research_plan"], gate: "plan" },
  { key: "gather", label: "Gather", blurb: "Filings, calls and facts", stages: ["source_discovery", "source_ingestion", "evidence_extraction", "historical_record"] },
  { key: "understand", label: "Understand", blurb: "How the business works", stages: ["company_genesis", "historical_diagnosis", "business_process_analysis", "moat_analysis", "operating_model"] },
  { key: "value", label: "Value", blurb: "Scenarios, value and tests", stages: ["operating_scenarios", "asset_valuation", "indicator_design", "strategy_design", "backtest_execution", "backtest_review"] },
  { key: "decide", label: "Decide", blurb: "Rating, report and review", stages: ["decision_synthesis", "report_draft", "ai_reviewer", "human_review", "export", "refresh_schedule"], gate: "review" },
];

/** What each stage does, in plain words: while it runs, and once it has finished. */
const STAGE_WORDS: Record<string, { doing: string; done: string }> = {
  intake: { doing: "Reading your question", done: "Read your question" },
  asset_identity: { doing: "Confirming which company this is", done: "Confirmed the company and its listing" },
  archetype_composition: { doing: "Working out what kind of business it is", done: "Worked out what kind of business it is" },
  research_plan: { doing: "Drafting the research plan", done: "Settled the research plan" },
  source_discovery: { doing: "Finding filings, calls and reports to read", done: "Found the filings, calls and reports to read" },
  source_ingestion: { doing: "Reading the sources", done: "Read the sources" },
  evidence_extraction: { doing: "Pulling facts out of the sources", done: "Pulled the facts out of the sources" },
  historical_record: { doing: "Building the financial history", done: "Built the financial history" },
  company_genesis: { doing: "Writing how the company got here", done: "Wrote how the company got here" },
  historical_diagnosis: { doing: "Explaining what drove past results", done: "Explained what drove past results" },
  business_process_analysis: { doing: "Mapping how the company makes money", done: "Mapped how the company makes money" },
  moat_analysis: { doing: "Judging how durable its advantages are", done: "Judged how durable its advantages are" },
  operating_model: { doing: "Building the operating model", done: "Built the operating model" },
  operating_scenarios: { doing: "Drawing up bear, base and bull scenarios", done: "Drew up the bear, base and bull scenarios" },
  asset_valuation: { doing: "Valuing the company in each scenario", done: "Valued the company in each scenario" },
  indicator_design: { doing: "Choosing the signals to track", done: "Chose the signals to track" },
  strategy_design: { doing: "Designing trading rules to test", done: "Designed the trading rules to test" },
  backtest_execution: { doing: "Testing the rules on past prices", done: "Tested the rules on past prices" },
  backtest_review: { doing: "Checking what the tests show", done: "Checked what the tests show" },
  decision_synthesis: { doing: "Building the rating from the valuation", done: "Built the rating from the valuation" },
  report_draft: { doing: "Writing the report", done: "Wrote the report" },
  ai_reviewer: { doing: "Reviewing the report for gaps and errors", done: "Reviewed the report for gaps and errors" },
  human_review: { doing: "Waiting for your review", done: "You reviewed the report" },
  export: { doing: "Exporting the report", done: "Exported the report" },
  refresh_schedule: { doing: "Scheduling the next refresh", done: "Scheduled the next refresh" },
};

const DONE = new Set(["completed", "skipped"]);
const ACTIVE = new Set(["running", "queued"]);

export type PhaseState = "done" | "active" | "waiting" | "failed" | "pending";
export interface PhaseProgress extends RunPhase { total: number; done: number; state: PhaseState }

/** Each phase's progress over the stages present in a run (unknown keys ignored). Skipped stages count as done. */
export function phaseProgress(stages: readonly FlowStage[]): PhaseProgress[] {
  return RUN_PHASES.map((phase) => {
    const mine = stages.filter((s) => phase.stages.includes(s.key));
    const done = mine.filter((s) => DONE.has(s.status)).length;
    const state: PhaseState = mine.some((s) => s.status === "failed") ? "failed"
      : mine.some((s) => s.status === "waiting_for_human") ? "waiting"
      : mine.some((s) => ACTIVE.has(s.status)) || (done > 0 && done < mine.length) ? "active"
      : mine.length > 0 && done === mine.length ? "done" : "pending";
    return { ...phase, total: mine.length, done, state };
  });
}

/** Where a person is in the flow: no run asks the question; before the plan is approved it's the plan step. */
export function flowStep(input: { hasRun: boolean; status: string | null | undefined; stages: readonly FlowStage[] }): { index: number; key: FlowStepKey } {
  const at = (key: FlowStepKey) => ({ index: FLOW_STEPS.findIndex((s) => s.key === key), key });
  if (!input.hasRun) return at("question");
  const plan = input.stages.find((s) => s.key === "research_plan");
  if (!plan || !DONE.has(plan.status)) return at("plan");
  const reviewWaiting = input.stages.some((s) => s.key === "human_review" && s.status === "waiting_for_human");
  if (reviewWaiting || ["completed", "approved"].includes(String(input.status))) return at("review");
  return at("research");
}

const words = (key: string) => STAGE_WORDS[key] ?? { doing: "Working on the next step", done: "Finished a step" };

/** One sentence for what is happening now: the running stage, else a queued one; null when nothing is. */
export function runNow(stages: readonly FlowStage[]): string | null {
  const current = stages.find((s) => s.status === "running") ?? stages.find((s) => s.status === "queued");
  return current ? words(current.key).doing : null;
}

export interface FeedItem { text: string; at: string | null; now?: boolean }

/** The run in plain words, newest first: what is running now, then each finished stage with when it finished. */
export function runFeed(stages: readonly FlowStage[]): FeedItem[] {
  const order = new Map<string, number>(STAGE_CONFIGS.map((s, i) => [s.key, i]));
  const now = stages.filter((s) => s.status === "running").map((s) => ({ text: words(s.key).doing, at: s.started_at ?? null, now: true }));
  const done = stages.filter((s) => s.status === "completed")
    .map((s) => ({ text: words(s.key).done, at: s.completed_at ?? null, rank: order.get(s.key) ?? 0 }))
    .sort((a, b) => (b.at && a.at ? b.at.localeCompare(a.at) : b.at ? 1 : a.at ? -1 : 0) || b.rank - a.rank)
    .map(({ text, at }) => ({ text, at }));
  return [...now, ...done];
}

export interface RunEstimate { runs: number; medianCostUsd: number; medianMinutes: number }
export interface EstimateRow {
  run_type: string; actual_cost_usd: string | number | null; created_at: string | Date | null;
  plan_started_at: string | Date | null; plan_completed_at: string | Date | null; review_completed_at: string | Date | null;
}

const ms = (v: string | Date | null) => (v == null ? NaN : new Date(v).getTime());
function median(values: number[]) {
  const s = [...values].sort((a, b) => a - b), mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Typical cost and machine time of past runs, by run type. Time leaves out the wait at the plan gate:
 * (plan started − created) + (report review finished − plan approved). Runs that never reached the report review, or
 * whose times don't add up, are left out; a type with none left has no entry.
 */
export function runEstimates(rows: readonly EstimateRow[]): Record<string, RunEstimate> {
  const by = new Map<string, { cost: number[]; minutes: number[] }>();
  for (const r of rows) {
    const pre = ms(r.plan_started_at) - ms(r.created_at), post = ms(r.review_completed_at) - ms(r.plan_completed_at);
    const cost = Number(r.actual_cost_usd);
    if (!Number.isFinite(pre) || !Number.isFinite(post) || pre < 0 || post < 0 || !Number.isFinite(cost)) continue;
    const g = by.get(r.run_type) ?? { cost: [], minutes: [] };
    g.cost.push(cost); g.minutes.push((pre + post) / 60_000); by.set(r.run_type, g);
  }
  return Object.fromEntries([...by].map(([type, g]) => [type, {
    runs: g.cost.length, medianCostUsd: Math.round(median(g.cost) * 100) / 100, medianMinutes: Math.round(median(g.minutes)),
  }]));
}

/** "Past 3 runs: about $1.72 and 45 min", or that there is no history for this type. */
export function formatEstimate(e: RunEstimate | undefined): string {
  if (!e || e.runs === 0) return "No past runs of this type yet";
  const m = Math.round(e.medianMinutes);
  const time = m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
  return `${e.runs} past run${e.runs === 1 ? "" : "s"}: typically $${e.medianCostUsd.toFixed(2)} and ${time}`;
}

/** The run types a person can pick, with what each actually does differently (stages.ts, evidence and refresh). */
export const RUN_DEPTHS = [
  { value: "quick_scan", label: "Quick scan", detail: "Fewer facts and no backtest stages; refresh after 180 days" },
  { value: "thesis_investigation", label: "Thesis investigation", detail: "Every stage, standard fact depth; refresh after 180 days" },
  { value: "deep_dive", label: "Deep dive", detail: "Every stage including backtests, deeper fact extraction; refresh after 90 days" },
  { value: "full_initiation_report", label: "Initiation report", detail: "Same stages and depth as a deep dive, filed as an initiation; refresh after 90 days" },
] as const;

export interface WaitingItem { kind: "review" | "plan"; run_id: string; asset_id: string; asset_name: string; ticker?: string | null; href: string; label: string }
interface QueueRow { run_id: string; asset_id: string; asset_name: string }
interface AssetRow { id: string; canonical_name: string; ticker?: string | null; latest_run?: { id: string; status: string; waiting_stage_key?: string | null } | null }

/** What waits on the person: final reviews first (the review queue), then plans to approve; each run once. */
export function waitingOnYou(queue: readonly QueueRow[], assets: readonly AssetRow[]): WaitingItem[] {
  const tickers = new Map(assets.map((a) => [a.id, a.ticker ?? null]));
  const reviews: WaitingItem[] = queue.map((q) => ({ kind: "review", run_id: q.run_id, asset_id: q.asset_id, asset_name: q.asset_name,
    ticker: tickers.get(q.asset_id) ?? null, href: `/review?run=${q.run_id}`, label: "Needs your decision" }));
  const listed = new Set(reviews.map((r) => r.run_id));
  const plans: WaitingItem[] = assets
    .filter((a) => a.latest_run?.status === "waiting_for_human" && a.latest_run.waiting_stage_key === "research_plan" && !listed.has(a.latest_run.id))
    .map((a) => ({ kind: "plan", run_id: a.latest_run!.id, asset_id: a.id, asset_name: a.canonical_name, ticker: a.ticker ?? null,
      href: `/assets/${a.id}/run?run=${a.latest_run!.id}`, label: "Needs plan approval" }));
  return [...reviews, ...plans];
}
