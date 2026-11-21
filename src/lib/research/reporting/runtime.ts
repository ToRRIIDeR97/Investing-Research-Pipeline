import { callResearchAgent, exactJsonPrompt, type ResearchRunContext, type Sql } from "../run-context";
import { AI_REVIEWER_CONTRACT } from "../stage-contracts";
import { COVERAGE, OUTLINE_CONTRACT, SECTION_CONTRACT, CoverageResult, Outline, Section, WrittenSectionAnswer, normalizeOutlineStructure, validateProductOutline, storedSection, writerContract, type ReportOutline, type ReportSection, type CoverageCheck, type WriterSection } from "./contracts";
import { buildExhibits, isAvailable, placeExhibits, type BuiltExhibit } from "./exhibits";
import { composeDraft, draftDocument, reviewDraftedReport, checkFinalCoverage, type CompositionActions, type ReportReview, type WrittenSection, REQUIRED_COVERAGE } from "./compose";
import { z } from "zod/v4";
import { DEPTH_CHECKS, DEPTH_CHECK_RULE, REWORK_STAGES, depthFindings } from "./depth";
import { loadReportInputs, saveReportArtifact } from "./store";
import { createReport, reviewDocument } from "./report";
import type { AgentOutputFormat } from "@/lib/agent-harness/types";
import { VISUAL_GUIDELINES, validateVisual } from './visuals';
import { getTeamRequests, includeUnansweredQuestions, requestMissingResearch, preDraftBatch, preDraftRequests, postReviewAnswers, ResearchRequestsPending } from "../team";
import { saveVersionChangeLog, loadPriorResearch } from "../lineage/runs";
import { PRIOR_RESEARCH_RULE } from "../lineage/prior-research";
import { buildReportFacts } from "./facts";
import { researchPacketForModel } from "./packet";
import { citationRefs } from "./refs";
import { cleanReaderFields } from "./reader-prose";

/** Computed inputs every report call shares; they lead the packet instead of riding in each section's artifacts. */
export const SHARED_REPORT_TYPES = ["financial_analytics", "financial_statement_summary", "report_facts"];
export const REPORT_FACTS_RULE = "financial_analytics (computed history: statistics, segment economics, cash conversion, working capital, capital allocation), financial_statement_summary (which statements were captured) and report_facts (present values, terminal-value share, yields, implied multiples and no-rerating returns computed from the stored schedules) are code-computed. Cite their artifact_id for any figure they hold and never derive it again in prose; for statistics give the median and where the latest value sits. Code builds the report's tables and charts from them and the stored scenario and valuation sets. Report a statement gap only where financial_statement_summary shows one.";

/** The outline packet's exhibit rule: code places the catalogue, so the outline plans no chart or table. */
export const EXHIBIT_CATALOGUE_RULE = "exhibit_catalogue lists the tables and charts code builds from stored data (available false when the data cannot support one). Code places each available exhibit in the first chapter, other than the opening summary, whose coverage includes its home area. Plan no charts or tables; let coverage decide where each exhibit appears.";
/** A section packet's exhibit rule; the same text for every body section, so the shared prompt stays cached. */
export const SECTION_EXHIBITS_RULE = "section_exhibits are the tables and charts code built from stored data and prints in this chapter after your prose. Discuss them by title where they support the analysis and explain what drives them; do not repeat every number, and do not request tables or charts.";

/** A built exhibit as a writer reads it: its title, caption, column labels, formatted rows and notes. */
export const compactExhibit = (exhibit: BuiltExhibit) => ({ title: exhibit.title, caption: exhibit.caption,
  columns: exhibit.table.columns.map(c => c.label), rows: exhibit.table.rows, ...(exhibit.notes.length ? { notes: exhibit.notes } : {}) });

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
  "Use plain text inside paragraphs; no HTML, embedded links or Markdown tables. Do not request or author tables or charts: code builds each chapter's exhibits from stored data. Do not recalculate their values.",
  "Follow packet.visual_guidelines for the optional section.visuals: an organization chart or a process diagram, only where it explains more than prose. Visual claims require the same evidence and accounting discipline as paragraphs.",
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
 * passages; the last one also gets the provisional coverage to return reconciled. A body section given `exhibits`
 * (the code-built exhibits placed in it) reads them compact as section_exhibits.
 */
export function reportSectionCall<A extends { id: string; content_json: any }>(common: Record<string, any> & { evidence_claims: { id: string }[] }, packetArtifacts: A[],
  section: ReportOutline["sections"][number], outline: ReportOutline, feedback: Record<string, any>[], completed: ReportSection[], finalCoverage?: CoverageCheck[],
  exhibits?: BuiltExhibit[]) {
  const selected = packetArtifacts.filter(a => section.artifact_ids.includes(a.id));
  const conclusion = section.coverage.includes("conclusion") ? conclusionInputs(completed, common.evidence_claims) : null;
  const contract = finalCoverage ? CONCLUSION_CONTRACT : SECTION_CONTRACT;
  const artifacts = selected.length ? selected : packetArtifacts;
  const placed = !conclusion && exhibits ? exhibits : null;
  const packet = { ...common, ...(conclusion ? { evidence_claims: conclusion.evidence, filing_passages: [] } : {}),
    artifacts: conclusion ? artifacts.map(conclusionArtifactView) : artifacts, section_plan: section, ...(placed ? { section_exhibits: placed.map(compactExhibit) } : {}),
    // A conclusion reads the outline's questions and coverage whole, and of the other plans only what names them.
    outline: conclusion ? { ...outline, sections: outline.sections.map(({ id, title, coverage, key_figures }) => ({ id, title, coverage, ...(key_figures ? { key_figures } : {}) })) } : outline,
    feedback, completed_sections: conclusion?.chapters ?? [], ...(finalCoverage ? { provisional_coverage: finalCoverage } : {}),
    visual_guidelines: VISUAL_GUIDELINES, output_contract: "report_section", output_schema: contract.schema };
  // Sections of one round share everything but these keys, so the shared part is read from cache.
  return { packet, contract, perCallKeys: ["artifacts", "section_plan", "section_exhibits", "completed_sections", "provisional_coverage"],
    extraRules: [REPORT_FACTS_RULE, ...SECTION_RULES, ...(placed ? [SECTION_EXHIBITS_RULE] : []), ...(conclusion ? [CONCLUSION_DIGEST_RULE] : []), ...(finalCoverage ? [FINAL_COVERAGE_RULE] : [])] };
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
 * How a section write turns the model's answer into the stored result, in the value validation sees (`outputFormat`,
 * after `check`) and in the value stored (`finish`): storedSection, so tables, a chart plan and charts the writer still
 * sent are stripped and `exhibitKeys` (the exhibits code placed in the section) are set. With `visualInput`, an
 * organization or process visual that does not check against the stored data is dropped instead of failing the section.
 */
export function sectionWriteSteps<V>(section: ReportOutline["sections"][number], contract: AgentOutputFormat,
  check: (value: V) => V, validate: (value: V) => void, visualInput?: Parameters<typeof validateVisual>[1], exhibitKeys: string[] = []) {
  const buildable = (visual: Parameters<typeof validateVisual>[0]) => { try { validateVisual(visual, visualInput!); return true; } catch { return false; } };
  const tidy = (written: WriterSection): ReportSection => {
    const stored = storedSection(written, exhibitKeys);
    return visualInput && stored.visuals ? { ...stored, visuals: stored.visuals.filter(buildable) } : stored;
  };
  const stored = (value: V): V => (value as any)?.section ? { ...value, section: tidy((value as any).section) } : value;
  return { outputFormat: checkedContract(contract, validate, value => stored(check(value))), finish: stored };
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
export const CONCLUSION_CONTRACT = writerContract({ section: WrittenSectionAnswer, coverage: z.array(CoverageResult) });
export const CONCLUSION_DIGEST_RULE = "completed_sections are code-built digests of the finished chapters: each chapter's implication, one key point per paragraph, its counterevidence and gaps, and every evidence_id and artifact_id it cites. Synthesize from them and refer to a chapter by title; cite the IDs a digest lists for the point you use. Figures not in a digest, report_facts or financial_analytics stay with their chapter. An artifact's omitted_fields were analysed in the chapters that cite it.";
export const FINAL_COVERAGE_RULE ="packet.provisional_coverage is the planner's coverage, set before any chapter was written. Return coverage with one entry per key, keeping key and section_ids, and set status and rationale to what the completed chapters actually deliver: downgrade a status the chapters do not support. The rationale is reader-facing.";
/** Review finding categories that may send work back to the specialists after the review. */
const REWORK_CATEGORIES = ["research_gap", "calculation", "evidence", "analysis_rework"];

/** The two report stages. Their calls share one composition, so a draft call's packet is the same in either stage. */
export type ReportStageKey = "report_draft" | "ai_reviewer";

/** What the review stage needs from the draft that its artifacts don't hold. Saved on the report_draft stage row. */
export interface StoredDraftState {
  outline_id: string; section_ids: string[]; document_id: string;
  input_hash: string; content_hash: string; final_coverage: CoverageCheck[] | null; dropped_citations: string[];
}

/**
 * The stored draft no longer matches the run's report inputs. When `reopened`, report_draft and ai_reviewer are
 * pending again and the runner redrafts; otherwise the run had stopped running and nothing was changed. Either way the
 * runner treats it like a request pause: no failure, no retry and no transient count.
 */
export class ReportDraftReopened extends ResearchRequestsPending {
  constructor(readonly reopened = true) {
    super();
    this.message = reopened ? "The report inputs changed since the draft; report_draft was reopened"
      : "The report draft is stale, but the run is no longer running; nothing was reopened";
  }
}

/**
 * The calls and packets both report stages make: outline, sections, review, post-review rework and artifact saves.
 * `stageKey` records each call under the stage that makes it; it does not change a packet or a prompt.
 */
async function reportComposition(sql: Sql, ctx: ResearchRunContext, stageKey: ReportStageKey, droppedSeed: string[] = []) {
  const teamRequests = await getTeamRequests(sql, ctx.runId);
  const { artifacts, evidence, input_hash } = await loadReportInputs(sql, ctx.runId, ctx.cutoffAt.toISOString());
  const { shared, packetArtifacts } = splitReportArtifacts(artifacts);
  const dropped = new Set<string>(droppedSeed);
  // Report packets carry ev/ar/id tokens instead of UUIDs; every answer is mapped back to stored ids and cleaned of
  // leaked identifiers before validation and storage. Validation sees the same resolved value, without recording drops.
  const refs = citationRefs(artifacts, evidence);
  const answer = <T>(value: T, sink?: Set<string>) => cleanReaderFields(refs.resolve(value, sink));
  const resolved = (format: AgentOutputFormat): AgentOutputFormat => ({ ...format, validate: value => format.validate?.(answer(value)) ?? [] });
  const usable = <T>(value: T) => keepUsableReferences(value, artifacts, evidence, dropped);
  const check = <T>(value: T) => keepUsableReferences(value, artifacts, evidence);
  // Code places the exhibits, so a chart_plan the outline writer still sends is dropped.
  const withoutChartPlans = (outline: ReportOutline): ReportOutline => ({ ...outline, sections: (outline.sections || []).map(({ chart_plan: _plan, ...plan }) => plan) });
  const usableOutline = (value: { outline: ReportOutline }, keepIds = usable) => { const kept = keepIds(value); return { ...kept, outline: normalizeOutlineStructure(withoutChartPlans(kept.outline)) }; };
  // The launch exhibits, built once from the report inputs; placeExhibits assigns them to the outline's chapters.
  const exhibits = buildExhibits(artifacts, { cutoff: ctx.cutoffAt.toISOString() });
  const exhibitCatalogue = exhibits.map(e => ({ key: e.key, title: e.title, home: e.home, available: isAvailable(e) }));
  const placedIn = (outline: ReportOutline, sectionId: string) => {
    const keys = placeExhibits(outline.sections, exhibits)[sectionId] ?? [];
    return { keys, built: keys.flatMap(key => exhibits.filter(isAvailable).filter(e => e.key === key)) };
  };
  const [run] = await sql`SELECT metadata_json FROM research_runs WHERE id = ${ctx.runId}`;
  // The prior run's summary joins the packet here, and refs.packet tokenizes it with the rest; prepareResearchCall would add it
  // too, and skips a packet that already has it (so the rule is added here too).
  const prior = await loadPriorResearch(sql, ctx.runId);
  const priorRules = prior ? [PRIOR_RESEARCH_RULE] : [];
  const common = { asset: { assetName: ctx.assetName, symbol: ctx.symbol, profile: ctx.profileKey },
    research_question: ctx.researchQuestion, source_cutoff: ctx.cutoffAt.toISOString(),
    coverage_requirements: COVERAGE, ...shared, artifacts: packetArtifacts, evidence_claims: reportEvidenceView(evidence), specialist_requests: preDraftRequests(teamRequests),
    human_revision_request: run?.metadata_json?.report_revision_request || null, ...(prior ? { prior_research: prior } : {}) };
  const reportInput = { asset_name: ctx.assetName, cutoff: ctx.cutoffAt.toISOString(), is_test: ctx.testMode,
    required_coverage: REQUIRED_COVERAGE, artifacts, evidence };
  // The latest outline's sections, so rework requests from missing depth checks name the chapter that owns them.
  const tracked = { outlineSections: [] as ReportOutline["sections"] };
  // The id of each artifact a save stored (or kept, when unchanged), by type and scope.
  const savedIds = new Map<string, string>();
  const actions: CompositionActions = {
    async plan(feedback) {
      const packet = { ...common, exhibit_catalogue: exhibitCatalogue, feedback, output_contract: "report_outline", output_schema: OUTLINE_CONTRACT.schema };
      const output = usableOutline(answer(await callResearchAgent<{ outline: ReportOutline }>({ sql, ctx, stageKey,
        taskKey: "report:outline", taskType: "report_outline", agentName: "asset-analyst", modelTier: "mid", packet, packetTransform: refs.packet,
        outputFormat: resolved(checkedContract(OUTLINE_CONTRACT, ({ outline }: { outline: ReportOutline }) => {
          validateProductOutline(outline);
          createReport({ ...reportInput, ...outline, sections: outline.sections.map(section => ({ ...section,
            paragraphs: [{ kind: "analysis", text: section.purpose, evidence_ids: [], artifact_ids: section.artifact_ids }],
            counterevidence: "Outline validation", implication: "Outline validation", gaps: [], tables: [] })) });
        }, value => usableOutline(value, check))), promptFactory: p => exactJsonPrompt({ agentName: "asset-analyst", requiredKeys: ["outline"], packet: p,
          extraRules: [REPORT_FACTS_RULE,
            "Design a report outline around the material investment questions. Use company-specific section titles. Cover every coverage_requirements key exactly once in coverage, mapping it to one or more sections. First section should summarize the eventual judgment, and its coverage is conclusion only.",
            "Section coverage rules: every section whose coverage includes history or evidence must also include at least one other key (for example business, moat, management or constraints); a section covering only history and/or evidence is rejected. Exactly one section may include valuation, and that section must also include forecasts and downside; the opening summary section must not list valuation. Backtest and market-timing evidence belongs in a section that lists monitoring, because it tests timing indicators, not the fundamental thesis.",
            "Use full artifacts and evidence to investigate the questions. Record an answer, evidence/artifact IDs, materiality, status, and specific next evidence needed. Add questions discovered from contradictions or missing disclosures. Do not claim you fetched new evidence.",
            "Coverage states: satisfied for evidenced analysis including a no-moat finding; qualified for usable analysis with explained limits; blocked for a decision-critical gap; not_applicable only with asset-specific justification. A missing artifact is not evidence of inapplicability.",
            "Use only supplied artifact and evidence IDs. Keep numerical models unchanged. Request missing analysis in follow_up when artifacts cannot answer a material question. Prefer 8-16 substantial sections, maximum 24. No word-count target.",
            "Allocate key figures: give each section 2-5 key_figures (metric and period, e.g. \"FY2024 take rate\"). Assign each figure to exactly one section, the one that explains it; other sections refer to it rather than repeat it.",
            EXHIBIT_CATALOGUE_RULE,
            ...(ctx.researchFraming ? [FRAMING_OUTLINE_RULE] : []), ...priorRules] }) }), dropped));
      const unanswered = output.outline.questions.filter(q => q.status === "blocked" && q.materiality !== "supporting")
        .map(q => ({ category: "research_gap", question: q.question, follow_up: q.follow_up }));
      if (unanswered.length) await requestMissingResearch(sql, ctx, unanswered, "pre_draft", stageKey);
      const planned = includeFramingQuestions(includeUnansweredQuestions(output.outline, preDraftBatch(teamRequests)), ctx.researchFraming);
      tracked.outlineSections = planned.sections;
      return planned;
    },
    async write(section, outline, feedback, completed, options) {
      const finalCoverage = options?.coverage;
      const placed = placedIn(outline, section.id);
      const { packet, contract, perCallKeys, extraRules } = reportSectionCall(common, packetArtifacts, section, outline, feedback, completed, finalCoverage, placed.built);
      type Written = { section: ReportSection; coverage?: WrittenSection["final_coverage"] };
      const steps = sectionWriteSteps<Written>(section, contract, check, result => {
        if (result.section.id !== section.id || JSON.stringify(result.section.coverage) !== JSON.stringify(section.coverage)) throw new Error("Preserve section id and coverage exactly");
        createReport({ ...reportInput, required_coverage: section.coverage, sections: [result.section], questions: [],
          coverage: section.coverage.map(key => ({ key, status: "qualified", rationale: "Section validation", section_ids: [section.id] })) });
        if (finalCoverage) checkFinalCoverage(reportInput, outline, [...completed.filter(s => s.id !== section.id), result.section], result.coverage ?? []);
      }, reportInput, placed.keys);
      const output = steps.finish(usable(answer(await callResearchAgent<Written>({ sql, ctx, stageKey,
        taskKey: `report:section:${section.id}`, taskType: "report_section", agentName: "export-writer", modelTier: "mid", packet, packetTransform: refs.packet,
        perCallKeys, outputFormat: resolved(steps.outputFormat), promptFactory: p => exactJsonPrompt({ agentName: "export-writer", requiredKeys: contract.requiredKeys, packet: p, extraRules: [...extraRules, ...priorRules] }) }), dropped)));
      return finalCoverage ? { ...output.section, final_coverage: output.coverage } : output.section;
    },
    async review(document) {
      const packet = { ...common, visual_guidelines: VISUAL_GUIDELINES, report_document: reviewDocument(document),
        depth_checks: DEPTH_CHECKS.map(({ id, label, ask, critical }) => ({ id, label, ask, decision_critical: critical })),
        output_contract: "report_review", output_schema: AI_REVIEWER_CONTRACT.schema };
      const review = answer(await callResearchAgent<ReportReview>({ sql, ctx, stageKey, taskKey: "report:review", taskType: "ai_review",
        agentName: "research-reviewer", modelTier: "mid", packet, packetTransform: refs.packet, outputFormat: resolved(AI_REVIEWER_CONTRACT),
        promptFactory: p => exactJsonPrompt({ agentName: "research-reviewer", requiredKeys: AI_REVIEWER_CONTRACT.requiredKeys, packet: p,
          extraRules: [REPORT_FACTS_RULE,
            "Review the exact report_document against source passages AND complete analytical artifacts. Check citation entailment, unsupported facts/numbers, historical causes, counterarguments, operating-to-valuation links, contradictions across sections, numerical consistency and unjustified confidence. Flag analysis that lists figures without explaining what drove them, and figures repeated across sections.",
            "Review every organization or process visual under visual_guidelines: verify that the cited source entails each node, arrow and caption, and distinguish documented links from hypotheses. A correct reference alone does not prove the diagram; flag misleading causality or accounting as evidence/calculation defects.",
            "The report is supplied as complete structured sections, questions, coverage and hashes. Each section's exhibits name the tables and charts code built from the stored artifacts supplied alongside it, so their numbers are not the writer's; check that the prose agrees with them. Citations refer to evidence_claims; rendered Markdown is omitted to avoid repeating that content. Review all sections and all referenced data.",
            `Findings must name section_id, category (writing, evidence, calculation, research_gap, analysis_rework), severity and a concrete repair. Treat unavailable facts or missing analytical artifacts as research_gap. Use analysis_rework, with owner_stage (one of ${REWORK_STAGES.join(", ")}), only when a stage's own output is wrong or too thin and must be recomputed. Fail unsupported investment recommendations. Hedging does not substitute for analysis the stored data supports.`,
            DEPTH_CHECK_RULE,
            "Also review existing framework backtest requirements and proxy limitations. A backtest does not prove the fundamental thesis. Do not change model outputs through prose.",
            REVIEW_FRAMING_RULE, ...priorRules] }) }), dropped);
      return review;
    },
    // Called once, after the first review is saved: the post-review round may pause the run; on resume its answers come back.
    async rework(review) {
      const gaps = [...review.findings.filter(f => REWORK_CATEGORIES.includes(f.category)), ...depthFindings(review.depth_checks, tracked.outlineSections)];
      if (gaps.length) await requestMissingResearch(sql, ctx, gaps, "post_review", stageKey);
      return postReviewAnswers(await getTeamRequests(sql, ctx.runId));
    },
    async save(type, scope, content) {
      const row = await saveReportArtifact(sql, ctx, type, `${ctx.assetSlug}-${scope}`,
        type === "report_review" ? { ...content, dropped_citations: [...dropped].sort() } : content);
      savedIds.set(`${type}:${scope}`, String((row as { id: unknown }).id));
      return row;
    },
    async retain(type, scopes) {
      await sql`UPDATE research_artifacts SET status = 'superseded', updated_at = NOW()
        WHERE research_run_id = ${ctx.runId} AND artifact_type = ${type} AND status IN ('validated', 'accepted')
          AND scope_key <> ALL(${scopes.map(scope => `${ctx.assetSlug}-${scope}`)}::text[])`;
    },
  };
  return { actions, reportInput, input_hash, dropped, tracked, savedIds };
}

/**
 * report_draft: the version change log, pre-draft team requests, report_facts, the outline, every section and the
 * first report_document. The review stage reads that draft; what its artifacts don't hold is saved on the stage row.
 */
export async function draftReport(sql: Sql, ctx: ResearchRunContext) {
  // What changed since the prior run, computed by code before the report is written; nothing without a prior.
  await saveVersionChangeLog(sql, ctx);
  await requestMissingResearch(sql, ctx, [], "pre_draft", "report_draft");
  await saveReportFacts(sql, ctx);
  const composition = await reportComposition(sql, ctx, "report_draft");
  const draft = await composeDraft(composition.reportInput, composition.actions);
  const id = (type: string, scope: string) => composition.savedIds.get(`${type}:${scope}`)!;
  const state: StoredDraftState = {
    outline_id: id("report_outline", "outline"), section_ids: draft.sections.map(section => id("report_section", section.id)),
    document_id: id("report_document", "document"), input_hash: draft.document.input_hash, content_hash: draft.document.content_hash,
    final_coverage: draft.finalCoverage ?? null, dropped_citations: [...composition.dropped].sort(),
  };
  await saveDraftState(sql, ctx.runId, state);
  return draft;
}

/** Saves what the review stage needs from the draft on the report_draft stage row. */
export async function saveDraftState(sql: Sql, runId: string, state: StoredDraftState) {
  await sql`UPDATE research_stages SET completion_criteria_json = COALESCE(completion_criteria_json, '{}'::jsonb)
      || jsonb_build_object('report_draft', ${JSON.stringify(state)}::text::jsonb), updated_at = NOW()
    WHERE research_run_id = ${runId} AND stage_key = 'report_draft'`;
}

/** The draft as report_draft left it, or null when there is none to review. */
async function storedDraft(sql: Sql, ctx: ResearchRunContext): Promise<StoredDraftState | null> {
  const [stage] = await sql`SELECT status, completion_criteria_json->'report_draft' AS state FROM research_stages
    WHERE research_run_id = ${ctx.runId} AND stage_key = 'report_draft'`;
  return stage?.status === "completed" && stage.state ? stage.state as StoredDraftState : null;
}

/**
 * Puts report_draft and this stage back to pending, so the runner redrafts with the current inputs. One transaction
 * holding the run row, the lock orchestrator transitions (startReadyStages, gates, cancelRun, failRun) take: it
 * changes the stages only while the run is running and ai_reviewer is the running stage that called it.
 */
export async function reopenDraft(sql: Sql, ctx: Pick<ResearchRunContext, "runId">): Promise<never> {
  const reopened = await sql.begin(async tx => {
    const [run] = await tx`SELECT status FROM research_runs WHERE id = ${ctx.runId} FOR UPDATE`;
    if (run?.status !== "running") return false;
    const rows = await tx`UPDATE research_stages SET status = 'pending', started_at = NULL, completed_at = NULL, validation_result_json = NULL,
        transient_failures = 0, last_transient_error = NULL, failure_reason = NULL, updated_at = NOW()
      WHERE research_run_id = ${ctx.runId} AND stage_key IN ('report_draft', 'ai_reviewer')
        AND EXISTS (SELECT 1 FROM research_stages r WHERE r.research_run_id = ${ctx.runId} AND r.stage_key = 'ai_reviewer' AND r.status = 'running')
      RETURNING stage_key`;
    return rows.length > 0;
  });
  throw new ReportDraftReopened(reopened);
}

/**
 * ai_reviewer: rebuilds the stored draft from its artifacts (zod restores the key order jsonb dropped, so every
 * packet is the one the draft stage would have built), reviews it, then runs the post-review rework and the repair
 * round. A draft that no longer matches the report inputs, for example after a request round added evidence, is
 * redrafted first, as one composition would have done on resume.
 */
export async function reviewReport(sql: Sql, ctx: ResearchRunContext) {
  const { composition, draft } = await loadCurrentDraft(sql, ctx);
  return reviewDraftedReport(composition.reportInput, composition.actions, draft);
}

/**
 * The stored draft and the review stage's composition, when the draft still matches the run's report inputs. A
 * missing or stale draft reopens report_draft (reopenDraft) and throws ReportDraftReopened. The draft's artifacts are
 * read by the ids it saved, so rows a failed review attempt superseded are still found; report products are not
 * report inputs, so that attempt's repaired artifacts don't make the draft look stale.
 */
export async function loadCurrentDraft(sql: Sql, ctx: ResearchRunContext) {
  const state = await storedDraft(sql, ctx);
  if (!state) return reopenDraft(sql, ctx);
  const composition = await reportComposition(sql, ctx, "ai_reviewer", state.dropped_citations);
  if (composition.input_hash !== state.input_hash) return reopenDraft(sql, ctx);
  const ids = [state.outline_id, ...state.section_ids];
  const rows = await sql`SELECT id, content_json FROM research_artifacts WHERE research_run_id = ${ctx.runId} AND id = ANY(${ids}::uuid[])`;
  const content = new Map(rows.map(row => [String(row.id), row.content_json]));
  if (ids.some(id => !content.has(id))) return reopenDraft(sql, ctx);
  const outline = Outline.parse(content.get(state.outline_id));
  const sections = state.section_ids.map(id => Section.parse(content.get(id)));
  const draft = draftDocument(composition.reportInput, { outline, sections, finalCoverage: state.final_coverage ?? undefined });
  if (draft.document.content_hash !== state.content_hash) return reopenDraft(sql, ctx);
  composition.tracked.outlineSections = outline.sections;
  return { composition, draft };
}
