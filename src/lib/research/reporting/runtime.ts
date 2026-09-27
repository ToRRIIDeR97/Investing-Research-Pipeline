import { callResearchAgent, exactJsonPrompt, type ResearchRunContext, type Sql } from "../run-context";
import { AI_REVIEWER_CONTRACT } from "../stage-contracts";
import { COVERAGE, OUTLINE_CONTRACT, SECTION_CONTRACT, RESEARCH_DOCTRINE, validateProductOutline, type ReportOutline, type ReportSection } from "./contracts";
import { composeReviewedReport, type ReportReview, REQUIRED_COVERAGE } from "./compose";
import { loadReportInputs, saveReportArtifact } from "./store";
import { createReport, reviewDocument } from "./report";
import type { AgentOutputFormat } from "@/lib/agent-harness/types";
import { VISUAL_GUIDELINES } from './visuals';
import { getTeamRequests, includeUnansweredQuestions, requestMissingResearch } from "../team";

function checkedContract(base: AgentOutputFormat, check: (value: any) => void): AgentOutputFormat {
  return { ...base, validate(value) {
    const errors = base.validate?.(value) || [];
    if (errors.length) return errors;
    try { check(value); return []; }
    catch (error) { return [{ path: "report", message: String(error) }]; }
  } };
}

export async function draftAndReviewReport(sql: Sql, ctx: ResearchRunContext) {
  await requestMissingResearch(sql, ctx);
  const teamRequests = await getTeamRequests(sql, ctx.runId);
  const { artifacts, evidence } = await loadReportInputs(sql, ctx.runId, ctx.cutoffAt.toISOString());
  const [run] = await sql`SELECT metadata_json FROM research_runs WHERE id = ${ctx.runId}`;
  const common = { asset: { assetName: ctx.assetName, symbol: ctx.symbol, profile: ctx.profileKey },
    research_question: ctx.researchQuestion, source_cutoff: ctx.cutoffAt.toISOString(),
    coverage_requirements: COVERAGE, artifacts, evidence_claims: evidence, specialist_requests: teamRequests?.requests || [],
    human_revision_request: run?.metadata_json?.report_revision_request || null };
  const reportInput = { asset_name: ctx.assetName, cutoff: ctx.cutoffAt.toISOString(), is_test: ctx.testMode,
    required_coverage: REQUIRED_COVERAGE, artifacts, evidence };
  return composeReviewedReport(reportInput, {
    async plan(feedback) {
      const packet = { ...common, feedback, output_contract: "report_outline", output_schema: OUTLINE_CONTRACT.schema };
      const output = await callResearchAgent<{ outline: ReportOutline }>({ sql, ctx, stageKey: "ai_reviewer",
        taskKey: "report:outline", taskType: "report_outline", agentName: "asset-analyst", modelTier: "mid", packet,
        outputFormat: checkedContract(OUTLINE_CONTRACT, ({ outline }: { outline: ReportOutline }) => {
          validateProductOutline(outline);
          createReport({ ...reportInput, ...outline, sections: outline.sections.map(section => ({ ...section,
            paragraphs: [{ kind: "analysis", text: section.purpose, evidence_ids: [], artifact_ids: section.artifact_ids }],
            counterevidence: "Outline validation", implication: "Outline validation", gaps: [], tables: [] })) });
        }), promptFactory: p => exactJsonPrompt({ agentName: "asset-analyst", requiredKeys: ["outline"], packet: p,
          extraRules: [...RESEARCH_DOCTRINE,
            "Design a report outline around the material investment questions. Use company-specific section titles. Cover every coverage_requirements key exactly once in coverage, mapping it to one or more sections. First section should summarize the eventual judgment.",
            "Section coverage rules: every section whose coverage includes history or evidence must also include at least one other key (for example business, moat, management or constraints); a section covering only history and/or evidence is rejected. Exactly one section may include valuation, and that section must also include forecasts and downside.",
            "Use full artifacts and evidence to investigate the questions. Record an answer, evidence/artifact IDs, materiality, status, and specific next evidence needed. Add questions discovered from contradictions or missing disclosures. Do not claim you fetched new evidence.",
            "Coverage states: satisfied for evidenced analysis including a no-moat finding; qualified for usable analysis with explained limits; blocked for a decision-critical gap; not_applicable only with asset-specific justification. A missing artifact is not evidence of inapplicability.",
            "Use only supplied artifact and evidence IDs. Keep numerical models unchanged. Request missing analysis in follow_up when artifacts cannot answer a material question. Prefer 8-16 substantial sections, maximum 24. No word-count target."] }) });
      const unanswered = output.outline.questions.filter(q => q.status === "blocked" && q.materiality !== "supporting")
        .map(q => ({ category: "research_gap", question: q.question, follow_up: q.follow_up }));
      if (unanswered.length) await requestMissingResearch(sql, ctx, unanswered);
      return includeUnansweredQuestions(output.outline, teamRequests);
    },
    async write(section, outline, feedback, completed) {
      const selected = artifacts.filter(a => section.artifact_ids.includes(a.id));
      const packet = { ...common, artifacts: selected.length ? selected : artifacts, section_plan: section, outline,
        feedback, completed_sections: section.coverage.includes("conclusion") ? completed : [],
        visual_guidelines: VISUAL_GUIDELINES, output_contract: "report_section", output_schema: SECTION_CONTRACT.schema };
      const output = await callResearchAgent<{ section: ReportSection }>({ sql, ctx, stageKey: "ai_reviewer",
        taskKey: `report:section:${section.id}`, taskType: "report_section", agentName: "export-writer", modelTier: "mid", packet,
        outputFormat: checkedContract(SECTION_CONTRACT, (result: { section: ReportSection }) => {
          if (result.section.id !== section.id || JSON.stringify(result.section.coverage) !== JSON.stringify(section.coverage)) throw new Error("Preserve section id and coverage exactly");
          createReport({ ...reportInput, required_coverage: section.coverage, sections: [result.section], questions: [],
            coverage: section.coverage.map(key => ({ key, status: "qualified", rationale: "Section validation", section_ids: [section.id] })) });
        }), promptFactory: p => exactJsonPrompt({ agentName: "export-writer", requiredKeys: ["section"], packet: p,
          extraRules: [...RESEARCH_DOCTRINE,
            "Write a detailed analytical section. Preserve section_plan.id and coverage exactly. Explain evidence, mechanism, historical context, counterevidence, uncertainty and investment consequences. Develop the reasoning in connected paragraphs; do not merely restate artifact fields.",
            "Paragraph kinds are fact, analysis, assumption or speculation. Cite exact supporting evidence_ids and artifact_ids for each paragraph. Unknown figures remain unknown. Uncited counterevidence and implication fields may synthesize the cited paragraphs but must not introduce new facts.",
            "Use plain text inside paragraphs; no HTML, embedded links or Markdown tables. Request tables as artifact_id and dot-separated path to the supplied data, with an empty path meaning the artifact root. Do not author or recalculate table values.",
            "Follow packet.visual_guidelines when choosing optional section.visuals. Omit visuals where they add no explanatory value. Visual claims require the same evidence and accounting discipline as paragraphs.",
            "If any material question or required coverage is blocked, withhold the investment conclusion. Describe the unresolved issue and what research is needed. Never turn a repair request into invented support."] }) });
      return output.section;
    },
    async review(document) {
      const packet = { ...common, visual_guidelines: VISUAL_GUIDELINES, report_document: reviewDocument(document), output_contract: "report_review", output_schema: AI_REVIEWER_CONTRACT.schema };
      const review = await callResearchAgent<ReportReview>({ sql, ctx, stageKey: "ai_reviewer", taskKey: "report:review", taskType: "ai_review",
        agentName: "research-reviewer", modelTier: "mid", packet, outputFormat: AI_REVIEWER_CONTRACT,
        promptFactory: p => exactJsonPrompt({ agentName: "research-reviewer", requiredKeys: AI_REVIEWER_CONTRACT.requiredKeys, packet: p,
          extraRules: [...RESEARCH_DOCTRINE,
            "Review the exact report_document against source passages AND complete analytical artifacts. Check citation entailment, unsupported facts/numbers, historical causes, counterarguments, operating-to-valuation links, contradictions across sections, numerical consistency and unjustified confidence.",
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
