import { z } from "zod/v4";
import type { AgentOutputFormat } from "@/lib/agent-harness/types";
import { ReportVisual, QUANTITATIVE_VISUALS } from './visuals';

/** adaptive-2: report tables print flat rows only (see flatTable). Reports stored under adaptive-1 render as before. */
export const STANDARD_VERSION = "asset-framework-2.1-adaptive-2";
export const COVERAGE = {
  ownership: "Investor claim, entity structure and value accrual",
  evidence: "Evidence quality, definitions, periods and missing disclosures",
  history: "Reported history, normalization, quarterly and TTM diagnosis",
  business: "Segments, value chain, customer decisions and cash conversion",
  constraints: "Bottlenecks, time lags and top-down/bottom-up reconciliation",
  moat: "Moat evidence, attacks, competitive response and no-moat economics",
  management: "Management, governance, capital allocation and per-share outcomes",
  forecasts: "Operating drivers, reinvestment and coherent scenarios",
  valuation: "Appropriate valuation methods and reverse operational expectations",
  downside: "Permanent impairment, no-rerating returns and scenario sensitivities",
  monitoring: "Thesis breakers, thresholds, indicators and affected assumptions",
  conclusion: "Decision, confidence by area and material unresolved questions",
} as const;

const id = z.string().min(1);
export const SectionPlan = z.object({
  id: id.regex(/^[a-z0-9_-]+$/), title: id, purpose: id,
  coverage: z.array(id), artifact_ids: z.array(id),
  // Figures this section presents and explains; other sections refer to them instead of repeating them.
  key_figures: z.array(id).optional(),
  // The chart a quantitative chapter should carry: the question, visual kind and stored data. Empty when none fits.
  chart_plan: z.string().max(400).optional(),
});
export const CoverageResult = z.object({
  key: id, status: z.enum(["satisfied", "qualified", "blocked", "not_applicable"]),
  rationale: id, section_ids: z.array(id),
});
export const Question = z.object({
  id, question: id, materiality: z.enum(["critical", "material", "supporting"]),
  status: z.enum(["answered", "qualified", "blocked"]), answer: id,
  evidence_ids: z.array(id), artifact_ids: z.array(id), follow_up: z.string(),
});
export const Outline = z.object({
  sections: z.array(SectionPlan).min(1).max(24),
  coverage: z.array(CoverageResult).min(1), questions: z.array(Question),
});
export const Section = SectionPlan.extend({
  paragraphs: z.array(z.object({
    kind: z.enum(["fact", "analysis", "assumption", "speculation"]), text: id,
    evidence_ids: z.array(id), artifact_ids: z.array(id),
  })).min(1),
  counterevidence: id, implication: id, gaps: z.array(id),
  tables: z.array(z.object({ title: id, artifact_id: id, path: z.string() })),
  visuals: z.array(ReportVisual).max(2).optional(),
});
export type ReportSection = z.infer<typeof Section>;
export type ReportOutline = z.infer<typeof Outline>;
export type ResearchQuestion = z.infer<typeof Question>;
export type CoverageCheck = z.infer<typeof CoverageResult>;

/**
 * Code repairs the two chapter rules where a coverage label is enough (seen failing in runs 02c8d48b and 81e42ee2):
 * a history/evidence-only section also covers business, and the one valuation section after the opening summary
 * also covers forecasts and downside. Other sections lose the valuation key, and the coverage map follows.
 * An outline it can't fix this way, such as valuation only in the summary, is left for validation.
 */
export function normalizeOutlineStructure(outline: ReportOutline): ReportOutline {
  const sections = outline.sections.map(s => ({ ...s, coverage: [...s.coverage] }));
  const coverage = outline.coverage.map(c => ({ ...c, section_ids: [...c.section_ids] }));
  const link = (key: string, id: string) => { const check = coverage.find(c => c.key === key); if (check && !check.section_ids.includes(id)) check.section_ids.push(id); };
  for (const s of sections) if (s.coverage.length && s.coverage.every((k): boolean => k === 'history' || k === 'evidence')) { s.coverage.push('business'); link('business', s.id); }
  const listed = sections.filter(s => s.coverage.includes('valuation'));
  const candidates = listed.filter(s => s !== sections[0]);
  const score = (s: { coverage: string[] }) => ['forecasts', 'downside'].filter(k => s.coverage.includes(k)).length;
  const keep = candidates.reduce<typeof candidates[number] | undefined>((best, s) => !best || score(s) > score(best) ? s : best, undefined);
  if (keep && listed.every(s => s === keep || s.coverage.length > 1)) {
    for (const s of listed) if (s !== keep) s.coverage = s.coverage.filter(k => k !== 'valuation');
    for (const key of ['forecasts', 'downside']) if (!keep.coverage.includes(key)) { keep.coverage.push(key); link(key, keep.id); }
    const check = coverage.find(c => c.key === 'valuation');
    if (check) check.section_ids = [keep.id];
  }
  return { ...outline, sections, coverage };
}

/** Reports every violation at once and names the sections, so one repair pass can fix them all. */
export function validateProductOutline(outline:ReportOutline) {
  const errors:string[]=[];
  const standalone=outline.sections.filter(s=>s.coverage.length>0&&s.coverage.every(k=>k==='history'||k==='evidence'));
  if(standalone.length)errors.push(`Integrate historical causes and material uncertainty into the company analysis; do not create standalone financial-history or evidence-limitations chapters. Add a company coverage key to, or merge: ${standalone.map(s=>`"${s.title}"`).join(', ')}.`);
  const valuation=outline.sections.filter(s=>s.coverage.includes('valuation'));
  if(valuation.length!==1||!['forecasts','downside'].every(k=>valuation[0].coverage.includes(k)))errors.push(`Combine forecasts, scenarios, valuation and permanent-loss analysis in one Valuation chapter: exactly one section may list valuation, together with forecasts and downside. Sections listing valuation now: ${valuation.map(s=>`"${s.title}"`).join(', ')||'none'}.`);
  if(errors.length)throw new Error(errors.join(' '));
}

/** A planned chart is drawn, or a gap says why it is not. */
export function validateChartPlan(plan: { chart_plan?: string }, section: ReportSection) {
  if (!plan.chart_plan?.trim() || (section.visuals ?? []).some(v => QUANTITATIVE_VISUALS.includes(v.kind)) || section.gaps.some(g => /\bcharts?\b/i.test(g))) return;
  throw new Error(`section_plan.chart_plan plans a chart ("${plan.chart_plan.trim()}"). Add it as a history, series, ratio, scenarios or valuation_bridge visual from stored data, or state in gaps why the chart is omitted.`);
}

export function outputContract(shape: Record<string, z.ZodType>): AgentOutputFormat {
  const schema = z.object(shape);
  return { requiredKeys: Object.keys(shape), schema: z.toJSONSchema(schema, { target: "draft-7", io: "input" }),
    validate(value) { const parsed = schema.safeParse(value); return parsed.success ? [] :
      parsed.error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message })); } };
}
export const OUTLINE_CONTRACT = outputContract({ outline: Outline });
export const SECTION_CONTRACT = outputContract({ section: Section });

/** What a strong analyst does, beyond format and integrity (RQ-MOD-5). Shared by every doctrine prompt. */
export const ANALYST_BEHAVIOUR_RULES = [
  "Separate the engines that earn from those that burn: give each segment's operating income, its share of group profit and the burners' losses as a share of the earners' profit, and value them separately.",
  "Place every current metric against its own history: give the median, range or percentile from the computed history, not the latest value alone, and say whether today is typical.",
  "Diagnose cash conversion: free cash flow against net income, capex against depreciation, and working-capital days, and explain why conversion moved.",
  "State what the investor owns: the share class held, voting versus economic control, and any value that may not reach the holder.",
  "Go below the bear case: name the impairment or tail case that would cause permanent loss, with its value, and what would change your mind.",
];

export const RESEARCH_DOCTRINE = [
  "The Financials deliverable is the complete issuer-reported primary statements from 10-Q and 10-K filings, with quarterly AND annual observations. Preserve custom line items, hierarchy, subtotals, fiscal calendars, units, source locations and restatements. A selected-metric shortlist is not complete. Check coverage against filing tables and reconcile totals. Never label annualized quarters or TTM as reported annual data. When financial_statement_summary is supplied, it is the record of what was captured: report a statement gap only where it shows one.",
  "Collect quarterly histories for every monitoring KPI, with stable metric_key, definition, unit, period, reporting basis and sources. Link thresholds and thesis breakers to model inputs. The KPI Dashboard and Monitoring and decision must use the same definitions and observations; never imply real-time disclosure where only a dated observation exists.",
  "Financials Metrics must expose sourced net income margin, gross margin, SG&A margin, ROE, ROIC and company-relevant ratios. State formulas and period conventions, align units and basis, use average balances when required, and distinguish unavailable inputs from economically inapplicable measures. Never invent missing inputs.",
  "Write company analysis directly in an analyst's voice, with adjacent citations. Do not narrate artifacts, packets, saved records, database fields, record IDs, confidence scores or the research workflow (never corpus, node or supplied passages). Retain material uncertainty beside the affected claim. Do not create standalone Financial history or Evidence and limitations chapters. Financials is a separate tab of filing tables beside the Report, not a report chapter: discuss financial history inside the business, constraints, management or valuation chapter it explains, and citations retain source access.",
  "Combine operating scenarios, valuation, downside and permanent loss in one Valuation chapter. Present numerical driver assumptions and annual schedules with explicit Bear, Base and Bull cases. Select appropriate valuation methods separately from scenarios, rather than forcing three DCF methods. Show actual discounting, terminal value, capital/share bridges or the chosen method's equivalent calculation. Do not describe an exit multiple or interpolated price path as a DCF.",
  "Each quantitative chapter (financial history, business and segments, operating scenarios, valuation) carries one chart built by code from stored data, such as segment mix, a margin trend, bear/base/bull scenarios or the valuation bridge; when the data cannot support it, say why. Other exhibits explain a material trend, comparison or business mechanism; no Supporting evidence block in every chapter. Use relevant segment numbers where available. Management should include a sourced organization chart with names, roles, effective dates and documented reporting lines; never infer hierarchy from seniority.",
  "Use Asset Research Agent Framework v2.1. Explain business processes and historical causes before relying on forecasts. Draft the executive judgment after the body; place it first.",
  "Separate disclosed facts, third-party data, derived estimates, analyst assumptions and speculative options. A citation ID alone does not prove a claim: verify the source passage supports the statement.",
  "Trace material forecasts through customer decisions, constraints, time lags, competitor responses, reinvestment and per-share value. Explain disagreements and what would disprove the interpretation.",
  "Use the latest reported fiscal periods available by the source cutoff, targeting 20 quarters where applicable. Preserve fiscal conventions, raw versus normalized data, units, currencies and missing periods. Do not fabricate quarterly data for semiannual reporters.",
  "Test moat claims against customer behavior and financial evidence. No demonstrated moat is a valid conclusion. Separate operating scenarios from valuation assumptions and examine permanent impairment and returns without rerating.",
  "Adapt metrics and valuation to the asset and each segment. Do not impose banking capital metrics on unrelated businesses. Treat framework equations as conceptual until units, periods and accounting definitions are established.",
  "Spend detail on questions that change valuation, downside or confidence. Explain unavailable disclosures and their consequences. Required coverage may be grouped under any useful headings; add company-specific sections when material.",
  "Never invent sources, quotations, numerical inputs or calculated results. Numerical tables must reference supplied artifact paths. Label incomplete analysis and withhold a decision when a material gap blocks it.",
  ...ANALYST_BEHAVIOUR_RULES,
];
