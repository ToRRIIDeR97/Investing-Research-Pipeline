/**
 * Depth review: a fixed list of analytical checks the reviewer must answer (framework §8/§11 and the JD
 * example's traits), and the code that turns its answers and findings into verdicts. The reviewer proposes
 * statuses; code overrides them where the stored data says otherwise, and derives every verdict.
 */
import { z } from "zod/v4";
import { calculateValuationSchedule, type ValuationMethodInput } from "../valuation/schedules";

type Row = Record<string, any>;

/** Analysis stages a review finding may send back. Deterministic and tail stages are not reworkable. */
export const REWORK_STAGES = ["company_genesis", "historical_diagnosis", "business_process_analysis", "moat_analysis",
  "operating_model", "operating_scenarios", "asset_valuation", "decision_synthesis"] as const;
export type ReworkStage = typeof REWORK_STAGES[number];

export interface DepthCheckDefinition {
  id: string; label: string; ask: string;
  /** A missing decision-critical check sends the report back; others cap the verdict at conditional_pass. */
  critical: boolean; owner_stage: ReworkStage;
}

export const DEPTH_CHECKS: DepthCheckDefinition[] = [
  { id: "decisive_insight", critical: true, owner_stage: "decision_synthesis", label: "Decisive insight",
    ask: "The opening states one central insight that reframes the investment question, with the classification and confidence." },
  { id: "ownership_and_control", critical: true, owner_stage: "company_genesis", label: "What the investor owns",
    ask: "Share classes, voting versus economic control, entity structure and how value reaches the holder." },
  { id: "segment_economics", critical: true, owner_stage: "business_process_analysis", label: "Segment economics",
    ask: "Which segments earn and which burn: segment revenue, operating income, margin and share of group profit." },
  { id: "history_statistics", critical: true, owner_stage: "historical_diagnosis", label: "History statistics",
    ask: "Current growth, margins and capex intensity positioned against their multi-year history (median, range, percentile)." },
  { id: "cash_conversion", critical: true, owner_stage: "historical_diagnosis", label: "Cash conversion",
    ask: "Free cash flow, FCF/net income and capex/D&A over time, and why conversion moved." },
  { id: "working_capital", critical: false, owner_stage: "historical_diagnosis", label: "Working capital",
    ask: "Receivable, inventory and payable days or the cash-conversion cycle where they matter." },
  { id: "capital_allocation", critical: true, owner_stage: "company_genesis", label: "Capital allocation and per-share outcomes",
    ask: "Net cash, share count change, buybacks and dividends against FCF, and the SBC offset." },
  { id: "demand_backdrop", critical: false, owner_stage: "business_process_analysis", label: "End-demand backdrop",
    ask: "The end-market or macro demand constraint the forecast assumes." },
  { id: "moat_attacks", critical: true, owner_stage: "moat_analysis", label: "Moat under attack",
    ask: "Each moat source rated and tested against named attacks, with competitor numbers." },
  { id: "management_assessment", critical: false, owner_stage: "company_genesis", label: "Management assessment",
    ask: "Management judged on separate axes: execution, balance sheet, capital allocation and governance." },
  { id: "valuation_matrix", critical: false, owner_stage: "asset_valuation", label: "Valuation matrix",
    ask: "Value per share across operating cases and valuation assumptions (discount rate, terminal), not one rate per case." },
  { id: "reverse_valuation", critical: true, owner_stage: "asset_valuation", label: "Reverse valuation",
    ask: "What the price implies, in FCF-growth or terminal terms a reader can test." },
  { id: "fcf_yield_cross_check", critical: true, owner_stage: "asset_valuation", label: "FCF-yield cross-check",
    ask: "FCF yield or an implied multiple cross-checks the cash-flow valuation." },
  { id: "no_rerating_return", critical: true, owner_stage: "asset_valuation", label: "No-rerating return",
    ask: "The return if today's multiple holds, per case." },
  { id: "tail_below_bear", critical: true, owner_stage: "operating_scenarios", label: "Tail below the bear case",
    ask: "A permanent-loss, impairment or tail case below the bear case, with its value." },
  { id: "thesis_breakers", critical: true, owner_stage: "decision_synthesis", label: "Thesis breakers",
    ask: "Thesis breakers with numeric thresholds and what each would change." },
  { id: "monitoring_dashboard", critical: false, owner_stage: "decision_synthesis", label: "Monitoring dashboard",
    ask: "A few monitored numbers with their current level and history context." },
  { id: "what_would_change_my_mind", critical: true, owner_stage: "decision_synthesis", label: "What would change my mind",
    ask: "Specific evidence or metric levels that would reverse the conclusion." },
  { id: "scorecard_confidence", critical: false, owner_stage: "decision_synthesis", label: "Scorecard",
    ask: "A scorecard or confidence by framework area." },
];
const DEFINITIONS = new Map(DEPTH_CHECKS.map((check) => [check.id, check]));

export const DEPTH_STATUSES = ["met", "partial", "missing", "data_unavailable", "not_applicable"] as const;
export const DepthCheck = z.object({
  id: z.enum(DEPTH_CHECKS.map((check) => check.id) as [string, ...string[]]),
  status: z.enum(DEPTH_STATUSES),
  section_id: z.string(),
  why: z.string().min(1),
});
export type DepthCheck = z.infer<typeof DepthCheck>;

/** Every check answered exactly once, so a reviewer can't skip the ones it would fail. */
export function depthCheckErrors(checks: { id: string }[]): string[] {
  const seen = new Map<string, number>();
  for (const check of checks) seen.set(check.id, (seen.get(check.id) ?? 0) + 1);
  return [...DEPTH_CHECKS.filter((check) => seen.get(check.id) !== 1)
    .map((check) => `depth_checks must answer "${check.id}" exactly once (got ${seen.get(check.id) ?? 0})`)];
}

/** Reviewer-facing description of the checks, for the review prompt. */
export const DEPTH_CHECK_RULE = "Answer depth_checks with one entry per check in packet.depth_checks: status met (the report carries the analysis), partial, missing (the stored data supports it but the report lacks it), data_unavailable (the stored data cannot support it; say what is absent), or not_applicable (explain why for this asset). Give the section_id that holds it, or an empty string, and a one-sentence why. Code checks your statuses against the stored data and derives the verdict: a missing decision-critical check sends the report back.";

const latest = (artifacts: Row[], type: string) => artifacts.filter((a) => a.artifact_type === type)
  .sort((a, b) => Number(b.artifact_version ?? 0) - Number(a.artifact_version ?? 0))[0]?.content_json ?? null;
const columnRows = (table: any): Row[] => Array.isArray(table?.columns) && Array.isArray(table?.rows)
  ? table.rows.map((row: unknown[]) => Object.fromEntries(table.columns.map((c: string, i: number) => [c, row[i]]))) : [];
const anyNumber = (rows: Row[], keys: string[]) => rows.some((row) => keys.some((key) => typeof row[key] === "number"));

/**
 * Whether the stored, code-computed artifacts can support a check: true or false where code can tell,
 * undefined where only the reviewer can judge.
 */
export function depthDataSupport(artifacts: Row[]): Record<string, boolean> {
  const pack = latest(artifacts, "financial_analytics");
  const facts = latest(artifacts, "report_facts");
  const support: Record<string, boolean> = {};
  if (pack) {
    support.history_statistics = columnRows(pack.statistics).some((row) => Number(row.n) >= 8 && typeof row.median === "number");
    support.segment_economics = anyNumber(columnRows(pack.segments?.quarterly), ["operating_income", "operating_margin"]);
    support.cash_conversion = anyNumber(columnRows(pack.cash_conversion?.quarterly), ["fcf_ttm", "fcf_to_net_income"]);
    support.working_capital = anyNumber(columnRows(pack.working_capital?.quarterly), ["dso", "dio", "dpo", "ccc"]);
    support.capital_allocation = anyNumber(columnRows(pack.capital_allocation?.quarterly), ["net_cash", "shares", "buybacks_ttm"]);
  }
  if (facts) {
    const cases = columnRows(facts.cases);
    support.no_rerating_return = cases.some((row) => typeof row.no_rerating_return === "number");
    support.fcf_yield_cross_check = typeof facts.market?.fcf_yield === "number" || typeof facts.market?.ev_to_nopat_ttm === "number";
  }
  return support;
}

export type ResolvedDepthCheck = DepthCheck & { label: string; critical: boolean; owner_stage: ReworkStage;
  reviewer_status?: DepthCheck["status"]; code_note?: string };

/**
 * Code's correction of the reviewer's statuses: data the stored pack holds can't be "data_unavailable",
 * and data it lacks can't be "missing". Checks the reviewer left out count as missing.
 */
export function resolveDepthChecks(checks: DepthCheck[] | undefined, artifacts: Row[]): ResolvedDepthCheck[] {
  const support = depthDataSupport(artifacts);
  return DEPTH_CHECKS.map((definition) => {
    const answer = checks?.find((check) => check.id === definition.id)
      ?? { id: definition.id, status: "missing" as const, section_id: "", why: "The reviewer did not answer this check." };
    const base = { ...answer, label: definition.label, critical: definition.critical, owner_stage: definition.owner_stage };
    const supported = support[definition.id];
    if (supported === true && answer.status === "data_unavailable")
      return { ...base, status: "missing" as const, reviewer_status: answer.status, code_note: "The stored computed data supports this check." };
    if (supported === false && answer.status === "missing")
      return { ...base, status: "data_unavailable" as const, reviewer_status: answer.status, code_note: "The stored computed data cannot support this check." };
    return base;
  });
}

const RANK = { pass: 0, conditional_pass: 1, needs_more_work: 2, fail: 3 } as const;
export type ReviewVerdict = keyof typeof RANK;
const worst = (...verdicts: ReviewVerdict[]) => verdicts.reduce((a, b) => RANK[b] > RANK[a] ? b : a, "pass");
const asVerdict = (value: unknown): ReviewVerdict => (typeof value === "string" && value in RANK ? value : "needs_more_work") as ReviewVerdict;

/** Missing decision-critical analysis sends the report back; unavailable data or partial work allows at most conditional_pass. */
export function depthVerdict(checks: ResolvedDepthCheck[]): ReviewVerdict {
  if (checks.some((check) => check.critical && check.status === "missing")) return "needs_more_work";
  if (checks.some((check) => (check.critical && ["partial", "data_unavailable"].includes(check.status)) || (!check.critical && check.status === "missing"))) return "conditional_pass";
  return "pass";
}

export interface CodeFlag { id: string; message: string; topic: RegExp }

/** Valuation consistency checks code can run on the stored artifacts. Each flag names the finding text it confirms. */
export function valuationFlags(artifacts: Row[]): CodeFlag[] {
  const flags: CodeFlag[] = [];
  const facts = latest(artifacts, "report_facts");
  const matrix = latest(artifacts, "expected_return_matrix");
  const valuation = latest(artifacts, "valuation_scenario_set");
  const cases = columnRows(facts?.cases);
  const highTv = cases.filter((row) => typeof row.tv_share_of_ev === "number" && row.tv_share_of_ev > 0.85);
  if (highTv.length) flags.push({ id: "terminal_share_high", topic: /terminal/i,
    message: `Terminal value is ${highTv.map((row) => `${Math.round(row.tv_share_of_ev * 100)}% (${row.case})`).join(", ")} of enterprise value.` });
  if (facts?.valuation_status === "complete" && cases.length && cases.every((row) => row.no_rerating_return === null))
    flags.push({ id: "no_rerating_missing", topic: /no[- ]?re-?rating/i, message: "No case has a no-rerating return." });
  if (matrix && typeof matrix.permanent_loss_limit === "number" && matrix.permanent_loss_limit === matrix.bear_return)
    flags.push({ id: "permanent_loss_equals_bear", topic: /permanent[- ]loss|tail|bear/i, message: "The permanent-loss limit equals the bear return, so no case sits below bear." });
  const schedules: ValuationMethodInput[] = Array.isArray(valuation?.method_inputs) ? valuation.method_inputs : [];
  for (const schedule of schedules) {
    if (schedule.terminal?.type !== "multiple") continue;
    let last;
    try { last = calculateValuationSchedule(schedule).years.at(-1); } catch { continue; }
    const nopat = last?.build?.starting_profit;
    if (last && typeof nopat === "number" && nopat > 0 && last.cash_flow / nopat < 0.5)
      flags.push({ id: `terminal_reinvestment_${schedule.scenario_type}`, topic: /terminal|multiple|capex|reinvest/i,
        message: `The ${schedule.scenario_type} case applies a terminal multiple to a year whose FCFF is ${Math.round(last.cash_flow / nopat * 100)}% of NOPAT.` });
  }
  return flags;
}

const findingText = (finding: Row) => Object.values(finding).filter((v) => typeof v === "string").join(" ");

/**
 * Findings that block position approval: any critical finding left in the final review, and any high
 * calculation finding a code flag confirms. Model severity labels are noisy, so unconfirmed highs don't block.
 */
export function blockingFindings(findings: Row[], flags: CodeFlag[]) {
  return findings.flatMap((finding) => {
    const severity = String(finding.severity ?? "").toLowerCase();
    if (severity === "critical") return [{ finding, reason: "Unresolved critical finding" }];
    if (severity !== "high" || String(finding.category ?? "").toLowerCase() !== "calculation") return [];
    const flag = flags.find((f) => f.topic.test(findingText(finding)));
    return flag ? [{ finding, reason: `High calculation finding confirmed by code: ${flag.message}` }] : [];
  });
}

export interface DerivedReview {
  model_verdict: ReviewVerdict;
  review_verdict: ReviewVerdict;
  effective_verdict: ReviewVerdict;
  depth_checks: ResolvedDepthCheck[];
  code_flags: { id: string; message: string }[];
  blocking: { reason: string; section_id?: string; issue?: string }[];
}

/**
 * review_verdict is the worse of the model's verdict and the depth verdict, and drives the repair round.
 * effective_verdict adds blocking findings and gates position approval. The model's own verdict is kept.
 * A review stored before depth checks existed has none, and only its findings count.
 */
export function deriveReview(review: { review_verdict: unknown; findings?: Row[]; depth_checks?: DepthCheck[] }, artifacts: Row[]): DerivedReview {
  const model = asVerdict(review.review_verdict);
  const checks = review.depth_checks ? resolveDepthChecks(review.depth_checks, artifacts) : [];
  const verdict = worst(model, depthVerdict(checks));
  const flags = valuationFlags(artifacts);
  const blocking = blockingFindings(review.findings ?? [], flags);
  return { model_verdict: model, review_verdict: verdict, effective_verdict: blocking.length ? worst(verdict, "needs_more_work") : verdict,
    depth_checks: checks, code_flags: flags.map(({ id, message }) => ({ id, message })),
    blocking: blocking.map(({ finding, reason }) => ({ reason, section_id: finding.section_id, issue: String(finding.issue ?? finding.message ?? finding.description ?? "") })) };
}

/** Missing decision-critical checks, as review findings the repair round and the rework requests can act on. */
export function depthFindings(checks: ResolvedDepthCheck[]) {
  return checks.filter((check) => check.critical && check.status === "missing").map((check) => ({
    section_id: check.section_id || undefined, category: "research_gap", severity: "high", source: "depth_check", check_id: check.id,
    owner_stage: check.owner_stage, issue: `${check.label} is missing: ${check.why}`, repair: DEFINITIONS.get(check.id)!.ask,
  }));
}

export const isPassing = (verdict: unknown) => verdict === "pass" || verdict === "conditional_pass";

/**
 * What a stored final review allows at the human gate. Tracking needs the reviewer's own verdict to pass, so a
 * check the data can never satisfy can't deadlock approval; a position also needs the effective verdict, which
 * missing decision-critical depth and blocking findings lower. Reviews stored before depth checks have only review_verdict.
 */
export function reviewGate(review: Row | null | undefined) {
  const model = review?.model_verdict ?? review?.review_verdict;
  const effective = review?.effective_verdict ?? review?.review_verdict;
  const findings: Row[] = Array.isArray(review?.findings) ? review!.findings : [];
  const checks: Row[] = Array.isArray(review?.depth_checks) ? review!.depth_checks : [];
  const blocking = [
    ...(Array.isArray(review?.blocking) ? review!.blocking.map((b: Row) => String(b.reason)) : []),
    ...checks.filter((c) => c.critical && c.status === "missing").map((c) => `${c.label ?? c.id} is missing`),
  ];
  return { trackable: Boolean(review) && isPassing(model), positionable: Boolean(review) && isPassing(effective),
    blocking: blocking.length ? blocking : effective && !isPassing(effective) ? [`the review verdict is ${effective}`] : [],
    open_severe: findings.filter((f) => ["high", "critical"].includes(String(f.severity ?? "").toLowerCase())).length };
}
export const depthCheckDefinition = (id: string) => DEFINITIONS.get(id);
