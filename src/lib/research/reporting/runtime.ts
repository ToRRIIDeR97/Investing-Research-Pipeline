import { callResearchAgent, exactJsonPrompt, type ResearchRunContext, type Sql } from "../run-context";
import { AI_REVIEWER_CONTRACT } from "../stage-contracts";
import { COVERAGE, OUTLINE_CONTRACT, SECTION_CONTRACT, RESEARCH_DOCTRINE, normalizeOutlineStructure, validateProductOutline, validateChartPlan, type ReportOutline, type ReportSection } from "./contracts";
import { composeReviewedReport, type ReportReview, REQUIRED_COVERAGE } from "./compose";
import { loadReportInputs, saveReportArtifact } from "./store";
import { createReport, reviewDocument } from "./report";
import type { AgentOutputFormat } from "@/lib/agent-harness/types";
import { VISUAL_GUIDELINES } from './visuals';
import { getTeamRequests, includeUnansweredQuestions, requestMissingResearch } from "../team";
import { buildReportFacts } from "./facts";

/** Computed inputs every report call shares; they lead the packet instead of riding in each section's artifacts. */
export const SHARED_REPORT_TYPES = ["financial_analytics", "financial_statement_summary", "report_facts"];
export const REPORT_FACTS_RULE = "financial_analytics (computed history: statistics, segment economics, cash conversion, working capital, capital allocation), financial_statement_summary (which statements were captured) and report_facts (present values, terminal-value share, yields, implied multiples and no-rerating returns computed from the stored schedules) are code-computed. Cite their artifact_id for any figure they hold and never derive it again in prose; for statistics give the median and where the latest value sits. Their { columns, rows } tables may be requested at their paths (for example quarterly, segments.quarterly, segments.annual, cash_conversion.quarterly, capital_allocation.quarterly, cases). Report a statement gap only where financial_statement_summary shows one.";

export const FRAMING_OUTLINE_RULE = "Answer the approved research_framing: give each framing key_question its own entry in questions with the same id, organize the sections around the central_question and the named engines, and make the opening conclusion section state whether the central_question and the decisive_insight_hypothesis held, with the evidence that decided it.";

/**
 * Framing key questions the outline left out are added as qualified material questions, so the reader and the
 * reviewer see the omission. They are not blocked: an unanswered framing question is a writing gap, not missing
 * evidence, and must not withhold the conclusion on its own.
 */
export function includeFramingQuestions(outline: ReportOutline, framing: Record<string, any> | null | undefined): ReportOutline {
  const keyQuestions: { id: string; question: string; falsifier?: string }[] = Array.isArray(framing?.key_questions) ? framing!.key_questions : [];
  const present = new Set(outline.questions.map(q => q.id));
  const missing = keyQuestions.filter(q => q.id && q.question && !present.has(q.id));
  if (!missing.length) return outline;
  return { ...outline, questions: [...outline.questions, ...missing.map(q => ({ id: q.id, question: q.question, materiality: "material" as const,
    status: "qualified" as const, answer: "This report does not answer this framing question.", evidence_ids: [], artifact_ids: [],
    follow_up: q.falsifier ? `Test the falsifier: ${q.falsifier}` : "Answer the framing question from the analysis." }))] };
}

/** Instructions for each report section writer, after the doctrine. */
export const SECTION_RULES = [
  "Write a detailed analytical section. Preserve section_plan.id and coverage exactly. Explain evidence, mechanism, historical context, counterevidence, uncertainty and investment consequences. Develop the reasoning in connected paragraphs; do not merely restate artifact fields.",
  "Analyse with frameworks, not commentary, where the data allow: revenue as price × volume, a margin bridge between periods, unit economics, return on incremental capital, and moat claims tested against specific KPIs and counter-evidence. Explain why each figure moved (price, volume, mix, cost, accounting), not only that it moved.",
  "Every analysis paragraph carries a figure or a citation. section_plan.key_figures are this section's to present and explain; for figures the outline allocates to other sections, refer to that section by title instead of repeating the number.",
  "Paragraph kinds are fact, analysis, assumption or speculation. Cite exact supporting evidence_ids and artifact_ids for each paragraph. Unknown figures remain unknown. Uncited counterevidence and implication fields may synthesize the cited paragraphs but must not introduce new facts.",
  "Use plain text inside paragraphs; no HTML, embedded links or Markdown tables. Request tables as artifact_id and dot-separated path to the supplied data, with an empty path meaning the artifact root. Do not author or recalculate table values. A table path must lead to rows of at most 60: a { columns, rows } table, one valuation schedule (method_schedules.N) or a list of flat records; a path to nested objects or a long observation list is rejected.",
  "Follow packet.visual_guidelines when choosing section.visuals. When section_plan.chart_plan names a chart, add it if the stored data supports it; otherwise omit it and add a gap saying why the chart could not be drawn. Add other visuals only where they explain more than prose. Visual claims require the same evidence and accounting discipline as paragraphs.",
  "If any material question or required coverage is blocked, withhold the investment conclusion. Describe the unresolved issue and what research is needed. Never turn a repair request into invented support."
];

/** Claims as report writers see them: code renders each citation's link and location from the stored claim. */
export const reportEvidenceView = <E extends { id: string }>(evidence: E[]) =>
  evidence.map(claim => Object.fromEntries(Object.entries(claim).filter(([key]) => key !== "url" && key !== "location")) as Omit<E, "url" | "location">);

/**
 * What a conclusion section reads of the finished chapters: their analysis, implications and gaps with the
 * citations they used. Tables, visuals and plan fields are left out, and so are claims no chapter cites.
 */
export function conclusionInputs<E extends { id: string }>(completed: ReportSection[], evidence: E[]) {
  const chapters = completed.map(({ id, title, paragraphs, counterevidence, implication, gaps }) => ({ id, title, paragraphs, counterevidence, implication, gaps }));
  const cited = new Set(chapters.flatMap(c => c.paragraphs.flatMap(p => p.evidence_ids || [])));
  return { chapters, evidence: evidence.filter(e => cited.has(e.id)) };
}

/** Save report_facts from the current valuation and analytics, so writers can cite it like any artifact. */
export async function saveReportFacts(sql: Sql, ctx: ResearchRunContext) {
  const { artifacts } = await loadReportInputs(sql, ctx.runId, ctx.cutoffAt.toISOString(),
    { types: ["valuation_scenario_set", "financial_analytics"], fingerprint: false, evidence: false });
  const facts = buildReportFacts(artifacts);
  if (facts) await saveReportArtifact(sql, ctx, "report_facts", `${ctx.assetSlug}-report-facts`, facts);
}

/** The packet artifacts and the shared computed inputs, keyed by type with their artifact_id. */
export function splitReportArtifacts<T extends { id: string; artifact_type: string; content_json: any }>(artifacts: T[]) {
  const shared = Object.fromEntries(SHARED_REPORT_TYPES.flatMap(type => {
    const artifact = artifacts.find(a => a.artifact_type === type);
    return artifact ? [[type, { artifact_id: artifact.id, ...artifact.content_json }]] : [];
  }));
  return { shared, packetArtifacts: artifacts.filter(a => !SHARED_REPORT_TYPES.includes(a.artifact_type)) };
}

function checkedContract(base: AgentOutputFormat, check: (value: any) => void, clean: (value: any) => any = (value) => value): AgentOutputFormat {
  return { ...base, validate(value) {
    const errors = base.validate?.(value) || [];
    if (errors.length) return errors;
    try { check(clean(value)); return []; }
    catch (error) { return [{ path: "report", message: String(error) }]; }
  } };
}

/**
 * The analysis stages see every accepted claim, but the report may cite only dated, linked evidence
 * and current artifacts. A citation outside that set is dropped, as for team answers, and a section
 * records the removal in its gaps. A fact left without support still fails validation.
 */
export function keepUsableReferences<T>(value: T, artifacts: { id: string }[], evidence: { id: string }[]): T {
  const usableArtifacts = new Set(artifacts.map((a) => a.id));
  const usableEvidence = new Set(evidence.map((e) => e.id));
  const dropped: string[] = [];
  const keep = (ids: string[] | undefined, usable: Set<string>) => (ids || []).filter((id) => usable.has(id) || (dropped.push(id), false));
  const refs = (item: any) => item && ({ ...item,
    ...(item.evidence_ids ? { evidence_ids: keep(item.evidence_ids, usableEvidence) } : {}),
    ...(item.artifact_ids ? { artifact_ids: keep(item.artifact_ids, usableArtifacts) } : {}) });
  const section = (s: any) => {
    const start = dropped.length;
    const next = { ...refs(s), ...(s.paragraphs ? { paragraphs: s.paragraphs.map(refs) } : {}) };
    const removed = dropped.slice(start);
    return removed.length && Array.isArray(s.gaps)
      ? { ...next, gaps: [...s.gaps, `Citations removed because their source is undated or outside the report inputs: ${removed.join(", ")}.`] }
      : next;
  };
  const v = value as any;
  if (v?.outline) return { ...v, outline: { ...v.outline, sections: (v.outline.sections || []).map(section),
    questions: (v.outline.questions || []).map(refs) } };
  if (v?.section) return { ...v, section: section(v.section) };
  return value;
}

export async function draftAndReviewReport(sql: Sql, ctx: ResearchRunContext) {
  await requestMissingResearch(sql, ctx);
  const teamRequests = await getTeamRequests(sql, ctx.runId);
  await saveReportFacts(sql, ctx);
  const { artifacts, evidence } = await loadReportInputs(sql, ctx.runId, ctx.cutoffAt.toISOString());
  const { shared, packetArtifacts } = splitReportArtifacts(artifacts);
  const usable = <T>(value: T) => keepUsableReferences(value, artifacts, evidence);
  const usableOutline = (value: { outline: ReportOutline }) => { const kept = usable(value); return { ...kept, outline: normalizeOutlineStructure(kept.outline) }; };
  const [run] = await sql`SELECT metadata_json FROM research_runs WHERE id = ${ctx.runId}`;
  const common = { asset: { assetName: ctx.assetName, symbol: ctx.symbol, profile: ctx.profileKey },
    research_question: ctx.researchQuestion, source_cutoff: ctx.cutoffAt.toISOString(),
    coverage_requirements: COVERAGE, ...shared, artifacts: packetArtifacts, evidence_claims: reportEvidenceView(evidence), specialist_requests: teamRequests?.requests || [],
    human_revision_request: run?.metadata_json?.report_revision_request || null };
  const reportInput = { asset_name: ctx.assetName, cutoff: ctx.cutoffAt.toISOString(), is_test: ctx.testMode,
    required_coverage: REQUIRED_COVERAGE, artifacts, evidence };
  return composeReviewedReport(reportInput, {
    async plan(feedback) {
      const packet = { ...common, feedback, output_contract: "report_outline", output_schema: OUTLINE_CONTRACT.schema };
      const output = usableOutline(await callResearchAgent<{ outline: ReportOutline }>({ sql, ctx, stageKey: "ai_reviewer",
        taskKey: "report:outline", taskType: "report_outline", agentName: "asset-analyst", modelTier: "mid", packet,
        outputFormat: checkedContract(OUTLINE_CONTRACT, ({ outline }: { outline: ReportOutline }) => {
          validateProductOutline(outline);
          createReport({ ...reportInput, ...outline, sections: outline.sections.map(section => ({ ...section,
            paragraphs: [{ kind: "analysis", text: section.purpose, evidence_ids: [], artifact_ids: section.artifact_ids }],
            counterevidence: "Outline validation", implication: "Outline validation", gaps: [], tables: [] })) });
        }, usableOutline), promptFactory: p => exactJsonPrompt({ agentName: "asset-analyst", requiredKeys: ["outline"], packet: p,
          extraRules: [...RESEARCH_DOCTRINE, REPORT_FACTS_RULE,
            "Design a report outline around the material investment questions. Use company-specific section titles. Cover every coverage_requirements key exactly once in coverage, mapping it to one or more sections. First section should summarize the eventual judgment, and its coverage is conclusion only.",
            "Section coverage rules: every section whose coverage includes history or evidence must also include at least one other key (for example business, moat, management or constraints); a section covering only history and/or evidence is rejected. Exactly one section may include valuation, and that section must also include forecasts and downside; the opening summary section must not list valuation. Backtest and market-timing evidence belongs in a section that lists monitoring, because it tests timing indicators, not the fundamental thesis.",
            "Use full artifacts and evidence to investigate the questions. Record an answer, evidence/artifact IDs, materiality, status, and specific next evidence needed. Add questions discovered from contradictions or missing disclosures. Do not claim you fetched new evidence.",
            "Coverage states: satisfied for evidenced analysis including a no-moat finding; qualified for usable analysis with explained limits; blocked for a decision-critical gap; not_applicable only with asset-specific justification. A missing artifact is not evidence of inapplicability.",
            "Use only supplied artifact and evidence IDs. Keep numerical models unchanged. Request missing analysis in follow_up when artifacts cannot answer a material question. Prefer 8-16 substantial sections, maximum 24. No word-count target.",
            "Allocate key figures: give each section 2-5 key_figures (metric and period, e.g. \"FY2024 take rate\"). Assign each figure to exactly one section, the one that explains it; other sections refer to it rather than repeat it.",
            "Chart plan: for each section covering history, business, forecasts or valuation, set chart_plan to the one chart that best answers its quantitative question, naming the visual kind and the stored data, for example segment revenue mix (series, stacked) or operating margin trend (ratio) from historical_record observations (series listed in its chart_series), bear/base/bull revenue or margins (scenarios) from operating_scenario_set, value per share (scenarios) or the valuation bridge (valuation_bridge) from valuation_scenario_set. Leave chart_plan empty only when no stored numeric data fits. Other sections leave it empty.",
            ...(ctx.researchFraming ? [FRAMING_OUTLINE_RULE] : [])] }) }));
      const unanswered = output.outline.questions.filter(q => q.status === "blocked" && q.materiality !== "supporting")
        .map(q => ({ category: "research_gap", question: q.question, follow_up: q.follow_up }));
      if (unanswered.length) await requestMissingResearch(sql, ctx, unanswered);
      return includeFramingQuestions(includeUnansweredQuestions(output.outline, teamRequests), ctx.researchFraming);
    },
    async write(section, outline, feedback, completed) {
      const selected = packetArtifacts.filter(a => section.artifact_ids.includes(a.id));
      // Conclusions synthesize the finished chapters and cite what they cite; filing passages serve the chapters' drafting.
      const conclusion = section.coverage.includes("conclusion") ? conclusionInputs(completed, common.evidence_claims) : null;
      const packet = { ...common, ...(conclusion ? { evidence_claims: conclusion.evidence, filing_passages: [] } : {}),
        artifacts: selected.length ? selected : packetArtifacts, section_plan: section, outline,
        feedback, completed_sections: conclusion?.chapters ?? [],
        visual_guidelines: VISUAL_GUIDELINES, output_contract: "report_section", output_schema: SECTION_CONTRACT.schema };
      // Sections of one round share everything but these keys, so the shared part is read from cache.
      const output = usable(await callResearchAgent<{ section: ReportSection }>({ sql, ctx, stageKey: "ai_reviewer",
        taskKey: `report:section:${section.id}`, taskType: "report_section", agentName: "export-writer", modelTier: "mid", packet,
        perCallKeys: ["artifacts", "section_plan", "completed_sections"], outputFormat: checkedContract(SECTION_CONTRACT, (result: { section: ReportSection }) => {
          if (result.section.id !== section.id || JSON.stringify(result.section.coverage) !== JSON.stringify(section.coverage)) throw new Error("Preserve section id and coverage exactly");
          validateChartPlan(section, result.section);
          createReport({ ...reportInput, required_coverage: section.coverage, sections: [result.section], questions: [],
            coverage: section.coverage.map(key => ({ key, status: "qualified", rationale: "Section validation", section_ids: [section.id] })) });
        }, usable), promptFactory: p => exactJsonPrompt({ agentName: "export-writer", requiredKeys: ["section"], packet: p,
          extraRules: [...RESEARCH_DOCTRINE, REPORT_FACTS_RULE, ...SECTION_RULES] }) }));
      return output.section;
    },
    async review(document) {
      const packet = { ...common, visual_guidelines: VISUAL_GUIDELINES, report_document: reviewDocument(document), output_contract: "report_review", output_schema: AI_REVIEWER_CONTRACT.schema };
      const review = await callResearchAgent<ReportReview>({ sql, ctx, stageKey: "ai_reviewer", taskKey: "report:review", taskType: "ai_review",
        agentName: "research-reviewer", modelTier: "mid", packet, outputFormat: AI_REVIEWER_CONTRACT,
        promptFactory: p => exactJsonPrompt({ agentName: "research-reviewer", requiredKeys: AI_REVIEWER_CONTRACT.requiredKeys, packet: p,
          extraRules: [...RESEARCH_DOCTRINE, REPORT_FACTS_RULE,
            "Review the exact report_document against source passages AND complete analytical artifacts. Check citation entailment, unsupported facts/numbers, historical causes, counterarguments, operating-to-valuation links, contradictions across sections, numerical consistency and unjustified confidence. Flag analysis that lists figures without explaining what drove them, and figures repeated across sections.",
            "Review every visual under visual_guidelines: verify that the cited source entails each node, arrow and caption, and distinguish documented links from hypotheses. Check chart selection, units, basis and missing observations. A correct reference alone does not prove the diagram; flag misleading causality or accounting as evidence/calculation defects.",
            "The report is supplied as complete structured sections, questions, coverage and hashes. Tables refer to the complete artifacts and citations refer to evidence_claims supplied alongside it; rendered Markdown is omitted to avoid repeating that content. Review all sections and all referenced data.",
            "Findings must name section_id, category (writing, evidence, calculation, research_gap), severity and a concrete repair. Treat unavailable facts or missing analytical artifacts as research_gap. Fail unsupported investment recommendations. A transparently qualified report may receive conditional_pass.",
            "Also review existing framework backtest requirements and proxy limitations. A backtest does not prove the fundamental thesis. Do not change model outputs through prose."] }) });
      const gaps = review.findings.filter(f => ["research_gap", "calculation", "evidence"].includes(f.category));
      if (gaps.length) await requestMissingResearch(sql, ctx, gaps);
      return review;
    },
    save: (type, scope, content) => saveReportArtifact(sql, ctx, type, `${ctx.assetSlug}-${scope}`, content),
  });
}
