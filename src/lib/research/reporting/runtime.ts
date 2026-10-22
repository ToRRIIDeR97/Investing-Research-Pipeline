import { callResearchAgent, exactJsonPrompt, type ResearchRunContext, type Sql } from "../run-context";
import { AI_REVIEWER_CONTRACT } from "../stage-contracts";
import { COVERAGE, OUTLINE_CONTRACT, SECTION_CONTRACT, CoverageResult, Section, normalizeOutlineStructure, validateProductOutline, validateChartPlan, outputContract, type ReportOutline, type ReportSection, type CoverageCheck } from "./contracts";
import { composeReviewedReport, checkFinalCoverage, type ReportReview, type WrittenSection, REQUIRED_COVERAGE } from "./compose";
import { z } from "zod/v4";
import { DEPTH_CHECKS, DEPTH_CHECK_RULE, REWORK_STAGES, depthFindings } from "./depth";
import { loadReportInputs, saveReportArtifact } from "./store";
import { createReport, reviewDocument } from "./report";
import type { AgentOutputFormat } from "@/lib/agent-harness/types";
import { VISUAL_GUIDELINES } from './visuals';
import { getTeamRequests, includeUnansweredQuestions, requestMissingResearch, preDraftBatch, preDraftRequests, postReviewAnswers } from "../team";
import { buildReportFacts } from "./facts";
import { researchPacketForModel } from "./packet";

/** Computed inputs every report call shares; they lead the packet instead of riding in each section's artifacts. */
export const SHARED_REPORT_TYPES = ["financial_analytics", "financial_statement_summary", "report_facts"];
export const REPORT_FACTS_RULE = "financial_analytics (computed history: statistics, segment economics, cash conversion, working capital, capital allocation), financial_statement_summary (which statements were captured) and report_facts (present values, terminal-value share, yields, implied multiples and no-rerating returns computed from the stored schedules) are code-computed. Cite their artifact_id for any figure they hold and never derive it again in prose; for statistics give the median and where the latest value sits. Their { columns, rows } tables may be requested at their paths (for example quarterly, segments.quarterly, segments.annual, cash_conversion.quarterly, capital_allocation.quarterly, cases). Report a statement gap only where financial_statement_summary shows one.";

/** The reviewer challenges the framing, not only consistency (RQ-MOD-5): these are calculation findings. */
export const REVIEW_FRAMING_RULE = "Challenge the valuation framing as calculation findings: a forecast horizon that ends inside a reinvestment cycle, terminal value above 75% of enterprise value (report_facts tv_share_of_ev), terminal-year capex far above depreciation, and unnormalized margins. Also check that the report answers research_framing's central_question and keeps its engines separate.";

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

/** Longest digest point, implication or counterevidence, gap and figure clause, in characters. */
export const DIGEST_LIMITS = { point: 320, summary: 1200, gap: 400, figure: 90 };
// A sentence ends at . ! or ? before whitespace, so decimals such as 1.5% stay inside it.
const sentencesOf = (text: string) => text.match(/(?:[^.!?]|[.!?]+(?!\s|$))+(?:[.!?]+|$)/g)?.map(s => s.trim()).filter(Boolean) ?? [];
const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
/** The opening sentence, plus the first sentence with a figure when the opening has none. */
function keyPoint(paragraph: ReportSection["paragraphs"][number]) {
  const sentences = sentencesOf(paragraph.text);
  const lead = sentences[0] ?? paragraph.text;
  const kind = paragraph.kind === "assumption" || paragraph.kind === "speculation" ? `[${paragraph.kind}] ` : "";
  return clip(kind + lead, DIGEST_LIMITS.point);
}
const FIGURE = /\d+(?:,\d{3})*(?:\.\d+)?/g;
// Clause boundaries inside a sentence; "200,966" has no space after its comma, so it stays whole.
const CLAUSE = /[,;:]\s+|\s+(?:while|whereas|but)\s+/;
/**
 * The figures a chapter states that its key points, summaries and gaps do not: for each, the clause that carries it
 * (for example "total costs and expenses rose to 42.03bn"), in the order the chapter states them.
 */
function otherFigures(section: ReportSection, digestText: string) {
  const shown = new Set(digestText.match(FIGURE) ?? []);
  const clauses: string[] = [];
  for (const sentence of [...section.paragraphs.map(p => p.text), section.implication, section.counterevidence, ...section.gaps].flatMap(sentencesOf))
    // A relative clause ("which is about 4.21 USD per share") keeps the clause it qualifies, so the figure keeps its subject.
    for (const clause of sentence.split(CLAUSE).reduce<string[]>((out, part) =>
      out.length && /^(?:which|that|who|giving|bringing|leaving|implying)\b/i.test(part) ? [...out.slice(0, -1), `${out.at(-1)}, ${part}`] : [...out, part], [])) {
      const text = clause.trim().replace(/^(?:and|or|so|then)\s+/i, "").replace(/[.!?]+$/, "");
      while (true) {
        const fresh = [...text.matchAll(FIGURE)].find(m => !shown.has(m[0]));
        if (!fresh) break;
        // A long clause is cut to a window that ends just after the figure, so the figure itself always survives.
        const end = Math.min(text.length, fresh.index! + fresh[0].length + 24);
        const start = Math.max(0, end - DIGEST_LIMITS.figure);
        const window = text.length <= DIGEST_LIMITS.figure ? text
          : `${start ? "…" : ""}${text.slice(start, end).replace(start ? /^\S*\s+/ : /^/, "").replace(end < text.length ? /\s+\S*$/ : /$/, "")}${end < text.length ? "…" : ""}`;
        (window.match(FIGURE) ?? []).forEach(f => shown.add(f));
        shown.add(fresh[0]);
        clauses.push(window);
      }
    }
  return clauses;
}
/**
 * A finished chapter as a conclusion writer reads it, built by code: its title and implication (the headline),
 * one key point per paragraph with the figure it carries, the counterevidence and gaps, every other figure it
 * states with its clause, and every evidence and artifact ID it cites. The full text stays in the report.
 */
export function chapterDigest(section: ReportSection) {
  const ids = (key: "evidence_ids" | "artifact_ids") => [...new Set(section.paragraphs.flatMap(p => p[key] || []))];
  const digest = { id: section.id, title: section.title, ...(section.key_figures?.length ? { key_figures: section.key_figures } : {}),
    implication: clip(section.implication, DIGEST_LIMITS.summary), key_points: section.paragraphs.map(keyPoint),
    counterevidence: clip(section.counterevidence, DIGEST_LIMITS.summary), gaps: section.gaps.map(g => clip(g, DIGEST_LIMITS.gap)) };
  return { ...digest, other_figures: otherFigures(section, JSON.stringify(digest)), evidence_ids: ids("evidence_ids"), artifact_ids: ids("artifact_ids") };
}

/** Largest top-level artifact field a conclusion packet carries; the chapters already analysed the larger ones. */
export const CONCLUSION_FIELD_BYTES = 4096;
/** Valuation v2 judgments a conclusion always reads, whatever their size. */
export const CONCLUSION_KEPT_FIELDS = ["valuation_matrix", "sanity", "cross_checks", "terminal_value_share", "value_beyond_explicit_share"];
/**
 * A selected artifact as a conclusion writer sees it: the model view (historical_record becomes its coverage and
 * reconciliation view first), then its top-level fields up to CONCLUSION_FIELD_BYTES each, plus CONCLUSION_KEPT_FIELDS.
 * Larger fields (schedules, inputs, chart series) are named in omitted_fields; their figures reach the conclusion
 * through report_facts, financial_analytics and the chapter digests, and their paths may still be requested as tables.
 */
export function conclusionArtifactView<T extends { content_json: any }>(artifact: T) {
  if (!artifact.content_json || typeof artifact.content_json !== "object" || Array.isArray(artifact.content_json)) return artifact;
  const content = researchPacketForModel(artifact.content_json);
  const omitted = Object.keys(content).filter(key => !CONCLUSION_KEPT_FIELDS.includes(key)
    && Buffer.byteLength(JSON.stringify(content[key] ?? null)) > CONCLUSION_FIELD_BYTES);
  return { ...artifact, content_json: omitted.length ? Object.fromEntries(Object.entries(content).filter(([key]) => !omitted.includes(key))) : content,
    ...(omitted.length ? { omitted_fields: omitted } : {}) };
}

/**
 * What a conclusion section reads of the finished chapters: a digest of each (see chapterDigest) and the claims
 * they cite. Tables, visuals, plan fields and claims no chapter cites are left out.
 */
export function conclusionInputs<E extends { id: string }>(completed: ReportSection[], evidence: E[]) {
  const chapters = completed.map(chapterDigest);
  const cited = new Set(chapters.flatMap(c => c.evidence_ids));
  return { chapters, evidence: evidence.filter(e => cited.has(e.id)) };
}

/**
 * The packet, contract and rules of one report-section call; the report runtime and the packet-size replay both
 * build it here. Conclusions read chapter digests, the claims those cite and capped artifacts, with no filing
 * passages; the last one also gets the provisional coverage to return reconciled.
 */
export function reportSectionCall<A extends { id: string; content_json: any }>(common: Record<string, any> & { evidence_claims: { id: string }[] }, packetArtifacts: A[],
  section: ReportOutline["sections"][number], outline: ReportOutline, feedback: Record<string, any>[], completed: ReportSection[], finalCoverage?: CoverageCheck[]) {
  const selected = packetArtifacts.filter(a => section.artifact_ids.includes(a.id));
  const conclusion = section.coverage.includes("conclusion") ? conclusionInputs(completed, common.evidence_claims) : null;
  const contract = finalCoverage ? CONCLUSION_CONTRACT : SECTION_CONTRACT;
  const artifacts = selected.length ? selected : packetArtifacts;
  const packet = { ...common, ...(conclusion ? { evidence_claims: conclusion.evidence, filing_passages: [] } : {}),
    artifacts: conclusion ? artifacts.map(conclusionArtifactView) : artifacts, section_plan: section,
    // A conclusion reads the outline's questions and coverage whole, and of the other plans only what names them.
    outline: conclusion ? { ...outline, sections: outline.sections.map(({ id, title, coverage, key_figures }) => ({ id, title, coverage, ...(key_figures ? { key_figures } : {}) })) } : outline,
    feedback, completed_sections: conclusion?.chapters ?? [], ...(finalCoverage ? { provisional_coverage: finalCoverage } : {}),
    visual_guidelines: VISUAL_GUIDELINES, output_contract: "report_section", output_schema: contract.schema };
  // Sections of one round share everything but these keys, so the shared part is read from cache.
  return { packet, contract, perCallKeys: ["artifacts", "section_plan", "completed_sections", "provisional_coverage"],
    extraRules: [REPORT_FACTS_RULE, ...SECTION_RULES, ...(conclusion ? [CONCLUSION_DIGEST_RULE] : []), ...(finalCoverage ? [FINAL_COVERAGE_RULE] : [])] };
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
 * and current artifacts. A citation outside that set is dropped, as for team answers, and its ID goes to
 * `dropped` (saved with the review), never to the reader. A fact left without support still fails validation.
 */
export function keepUsableReferences<T>(value: T, artifacts: { id: string }[], evidence: { id: string }[], dropped?: Set<string>): T {
  const usableArtifacts = new Set(artifacts.map((a) => a.id));
  const usableEvidence = new Set(evidence.map((e) => e.id));
  const keep = (ids: string[] | undefined, usable: Set<string>) => (ids || []).filter((id) => usable.has(id) || (dropped?.add(id), false));
  const refs = (item: any) => item && ({ ...item,
    ...(item.evidence_ids ? { evidence_ids: keep(item.evidence_ids, usableEvidence) } : {}),
    ...(item.artifact_ids ? { artifact_ids: keep(item.artifact_ids, usableArtifacts) } : {}) });
  const section = (s: any) => ({ ...refs(s), ...(s.paragraphs ? { paragraphs: s.paragraphs.map(refs) } : {}) });
  const v = value as any;
  if (v?.outline) return { ...v, outline: { ...v.outline, sections: (v.outline.sections || []).map(section),
    questions: (v.outline.questions || []).map(refs) } };
  if (v?.section) return { ...v, section: section(v.section) };
  return value;
}

/** The last conclusion also returns the report's coverage, reconciled with what the chapters actually did. */
export const CONCLUSION_CONTRACT = outputContract({ section: Section, coverage: z.array(CoverageResult) });
export const CONCLUSION_DIGEST_RULE = "completed_sections are code-built digests of the finished chapters: each chapter's implication, one key point per paragraph, its counterevidence and gaps, and every evidence_id and artifact_id it cites. Synthesize from them and refer to a chapter by title; cite the IDs a digest lists for the point you use. Figures not in a digest, report_facts or financial_analytics stay with their chapter. An artifact's omitted_fields were analysed in the chapters that cite it; their paths may still be requested as tables.";
export const FINAL_COVERAGE_RULE ="packet.provisional_coverage is the planner's coverage, set before any chapter was written. Return coverage with one entry per key, keeping key and section_ids, and set status and rationale to what the completed chapters actually deliver: downgrade a status the chapters do not support. The rationale is reader-facing.";
/** Review finding categories that may send work back to the specialists after the review. */
const REWORK_CATEGORIES = ["research_gap", "calculation", "evidence", "analysis_rework"];

export async function draftAndReviewReport(sql: Sql, ctx: ResearchRunContext) {
  await requestMissingResearch(sql, ctx);
  const teamRequests = await getTeamRequests(sql, ctx.runId);
  await saveReportFacts(sql, ctx);
  const { artifacts, evidence } = await loadReportInputs(sql, ctx.runId, ctx.cutoffAt.toISOString());
  const { shared, packetArtifacts } = splitReportArtifacts(artifacts);
  const dropped = new Set<string>();
  const usable = <T>(value: T) => keepUsableReferences(value, artifacts, evidence, dropped);
  const check = <T>(value: T) => keepUsableReferences(value, artifacts, evidence);
  const usableOutline = (value: { outline: ReportOutline }, keepIds = usable) => { const kept = keepIds(value); return { ...kept, outline: normalizeOutlineStructure(kept.outline) }; };
  const [run] = await sql`SELECT metadata_json FROM research_runs WHERE id = ${ctx.runId}`;
  const common = { asset: { assetName: ctx.assetName, symbol: ctx.symbol, profile: ctx.profileKey },
    research_question: ctx.researchQuestion, source_cutoff: ctx.cutoffAt.toISOString(),
    coverage_requirements: COVERAGE, ...shared, artifacts: packetArtifacts, evidence_claims: reportEvidenceView(evidence), specialist_requests: preDraftRequests(teamRequests),
    human_revision_request: run?.metadata_json?.report_revision_request || null };
  const reportInput = { asset_name: ctx.assetName, cutoff: ctx.cutoffAt.toISOString(), is_test: ctx.testMode,
    required_coverage: REQUIRED_COVERAGE, artifacts, evidence };
  // The latest outline's sections, so rework requests from missing depth checks name the chapter that owns them.
  let outlineSections: ReportOutline["sections"] = [];
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
        }, value => usableOutline(value, check)), promptFactory: p => exactJsonPrompt({ agentName: "asset-analyst", requiredKeys: ["outline"], packet: p,
          extraRules: [REPORT_FACTS_RULE,
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
      const planned = includeFramingQuestions(includeUnansweredQuestions(output.outline, preDraftBatch(teamRequests)), ctx.researchFraming);
      outlineSections = planned.sections;
      return planned;
    },
    async write(section, outline, feedback, completed, options) {
      const finalCoverage = options?.coverage;
      const { packet, contract, perCallKeys, extraRules } = reportSectionCall(common, packetArtifacts, section, outline, feedback, completed, finalCoverage);
      const output = usable(await callResearchAgent<{ section: ReportSection; coverage?: WrittenSection["final_coverage"] }>({ sql, ctx, stageKey: "ai_reviewer",
        taskKey: `report:section:${section.id}`, taskType: "report_section", agentName: "export-writer", modelTier: "mid", packet,
        perCallKeys, outputFormat: checkedContract(contract, (result: { section: ReportSection; coverage?: WrittenSection["final_coverage"] }) => {
          if (result.section.id !== section.id || JSON.stringify(result.section.coverage) !== JSON.stringify(section.coverage)) throw new Error("Preserve section id and coverage exactly");
          validateChartPlan(section, result.section);
          createReport({ ...reportInput, required_coverage: section.coverage, sections: [result.section], questions: [],
            coverage: section.coverage.map(key => ({ key, status: "qualified", rationale: "Section validation", section_ids: [section.id] })) });
          if (finalCoverage) checkFinalCoverage(reportInput, outline, [...completed.filter(s => s.id !== section.id), result.section], result.coverage ?? []);
        }, check), promptFactory: p => exactJsonPrompt({ agentName: "export-writer", requiredKeys: contract.requiredKeys, packet: p, extraRules }) }));
      return finalCoverage ? { ...output.section, final_coverage: output.coverage } : output.section;
    },
    async review(document) {
      const packet = { ...common, visual_guidelines: VISUAL_GUIDELINES, report_document: reviewDocument(document),
        depth_checks: DEPTH_CHECKS.map(({ id, label, ask, critical }) => ({ id, label, ask, decision_critical: critical })),
        output_contract: "report_review", output_schema: AI_REVIEWER_CONTRACT.schema };
      const review = await callResearchAgent<ReportReview>({ sql, ctx, stageKey: "ai_reviewer", taskKey: "report:review", taskType: "ai_review",
        agentName: "research-reviewer", modelTier: "mid", packet, outputFormat: AI_REVIEWER_CONTRACT,
        promptFactory: p => exactJsonPrompt({ agentName: "research-reviewer", requiredKeys: AI_REVIEWER_CONTRACT.requiredKeys, packet: p,
          extraRules: [REPORT_FACTS_RULE,
            "Review the exact report_document against source passages AND complete analytical artifacts. Check citation entailment, unsupported facts/numbers, historical causes, counterarguments, operating-to-valuation links, contradictions across sections, numerical consistency and unjustified confidence. Flag analysis that lists figures without explaining what drove them, and figures repeated across sections.",
            "Review every visual under visual_guidelines: verify that the cited source entails each node, arrow and caption, and distinguish documented links from hypotheses. Check chart selection, units, basis and missing observations. A correct reference alone does not prove the diagram; flag misleading causality or accounting as evidence/calculation defects.",
            "The report is supplied as complete structured sections, questions, coverage and hashes. Tables refer to the complete artifacts and citations refer to evidence_claims supplied alongside it; rendered Markdown is omitted to avoid repeating that content. Review all sections and all referenced data.",
            `Findings must name section_id, category (writing, evidence, calculation, research_gap, analysis_rework), severity and a concrete repair. Treat unavailable facts or missing analytical artifacts as research_gap. Use analysis_rework, with owner_stage (one of ${REWORK_STAGES.join(", ")}), only when a stage's own output is wrong or too thin and must be recomputed. Fail unsupported investment recommendations. Hedging does not substitute for analysis the stored data supports.`,
            DEPTH_CHECK_RULE,
            "Also review existing framework backtest requirements and proxy limitations. A backtest does not prove the fundamental thesis. Do not change model outputs through prose.",
            REVIEW_FRAMING_RULE] }) });
      return review;
    },
    // Called once, after the first review is saved: the post-review round may pause the run; on resume its answers come back.
    async rework(review) {
      const gaps = [...review.findings.filter(f => REWORK_CATEGORIES.includes(f.category)), ...depthFindings(review.depth_checks, outlineSections)];
      if (gaps.length) await requestMissingResearch(sql, ctx, gaps, "post_review");
      return postReviewAnswers(await getTeamRequests(sql, ctx.runId));
    },
    save: (type, scope, content) => saveReportArtifact(sql, ctx, type, `${ctx.assetSlug}-${scope}`,
      type === "report_review" ? { ...content, dropped_citations: [...dropped].sort() } : content),
  });
}
