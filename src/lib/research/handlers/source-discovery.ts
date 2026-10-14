import { z } from "zod/v4";
import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { makeValidationResult, callResearchAgent, exactJsonPrompt } from "../run-context";
import { fetchProfileResearchContext, storeSourceCorpus } from "../sources/corpus";
import { runSearches, type SearchResult } from "../sources/collector";
import { planMissingRoles, type SourcePlan } from "../sources/planner";
import { SOURCE_ROLES, type SourceRole } from "../sources/roles";
import { recordSourceCoverage, reconcileRoleGaps, sourcePlanFor, v2RunContext, withLinkedRunSources,
  type CoverageSource } from "../sources/role-coverage";
import { SEARCH_QUERY_RULE, SourceSearch } from "../sources/source-requests";
import { outputContract } from "../reporting/contracts";
import { saveReportArtifact } from "../reporting/store";
import { MAX_DISCOVERY_ROUNDS, TEAM_ROLES } from "../team-plan";
import postgres from "postgres";

export { mapToSourceRole, withLinkedRunSources, type CoverageSource } from "../sources/role-coverage";

type Sql = ReturnType<typeof postgres>;

const REVIEW_CONTRACT = outputContract({
  sufficient: z.boolean(),
  assessment: z.string().min(1),
  searches: z.array(SourceSearch).max(6),
  accepted_gaps: z.array(z.object({ source_role: z.enum(SOURCE_ROLES), reason: z.string().min(1) })),
});
type SourceReview = { sufficient: boolean; assessment: string; searches: SourceSearch[]; accepted_gaps: { source_role: SourceRole; reason: string }[] };
type DiscoveryRound = Omit<SourceReview, "searches"> & { round: number; searches: SearchResult[] };

/** The collector reviews the current corpus and either hands it to the specialists or names what to search next. */
async function reviewSources(sql: Sql, ctx: ResearchRunContext, plan: SourcePlan, covered: Set<SourceRole>,
  sources: CoverageSource[], rounds: DiscoveryRound[]): Promise<SourceReview> {
  const round = rounds.length + 1;
  const packet = {
    asset: { name: ctx.assetName, symbol: ctx.symbol }, research_question: ctx.researchQuestion,
    output_contract: "source_review", round, max_rounds: MAX_DISCOVERY_ROUNDS,
    source_plan: plan.items.map(item => ({ source_role: item.source_role, required: item.required,
      artifact_types: item.artifact_types, rationale: item.rationale })),
    covered_roles: [...covered], missing_required_roles: planMissingRoles(plan, [...covered]),
    documents: sources.filter(source => !source.sourceId.startsWith("candidate-")).slice(0, 80)
      .map(source => ({ title: source.title, url: source.url || null, source_type: source.sourceType,
        source_role: String(source.metadata?.source_role || "") || null })),
    previous_rounds: rounds.map(previous => ({ round: previous.round, assessment: previous.assessment,
      searches: previous.searches.map(search => ({ source_role: search.source_role, query: search.query, status: search.status,
        documents: (search.documents || []).map(document => document.title) })) })),
  };
  return callResearchAgent<SourceReview>({ sql, ctx, stageKey: "source_discovery", taskKey: `source-review:${round}`,
    taskType: "source_review", agentName: TEAM_ROLES.data.agent, modelTier: "cheap", packet, outputFormat: REVIEW_CONTRACT,
    promptFactory: p => exactJsonPrompt({ agentName: TEAM_ROLES.data.agent, requiredKeys: REVIEW_CONTRACT.requiredKeys!, packet: p,
      extraRules: [TEAM_ROLES.data.purpose,
        "The specialists (financials, business, valuation and report) start only after you set sufficient to true. Judge whether the documents can answer the research question and cover every required source role in source_plan.",
        "If not, return up to 6 searches {source_role, query, reason}. Each query must name a specific document or entity: for peer_company_primary, name a competitor and its filing (for example a named competitor's latest annual report or 20-F); for industry or regulatory roles, name the regulator, dataset or report. Never search generic phrases such as 'peer 10-K' or 'competitor report', and do not repeat a query from previous_rounds.",
        SEARCH_QUERY_RULE,
        "Set sufficient to true when the required roles are covered, or when further public searches are unlikely to help; list each uncovered required role in accepted_gaps with the reason. Specialists can request more documents later.",
        "Do not claim documents that are not in the documents list."] }),
  });
}

export const sourceDiscoveryHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "source_discovery",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const v2Ctx = v2RunContext(ctx);

      // Fetch public/SEC context
      const secContext = await fetchProfileResearchContext(v2Ctx);

      // Store source corpus in database (creates source_documents, parses, chunks, etc.).
      // Team requests never reopen discovery; processResearchRequests asks the collector instead.
      const sourceCorpus = await storeSourceCorpus(sql, v2Ctx, secContext);
      const sourcePlan = sourcePlanFor(ctx);

      // Replays must remove obsolete role/artifact matches from earlier source discovery.
      await sql`DELETE FROM source_role_coverage WHERE research_run_id = ${ctx.runId}`;
      // Role gaps were once owned by the source reader; the collector owns them now.
      await sql`UPDATE source_gaps SET status = 'resolved', resolved_at = NOW(),
        resolution_note = 'Superseded: role coverage gaps are owned by the source collector.'
        WHERE research_run_id = ${ctx.runId} AND owner = 'system:source-reader' AND status = 'open'
          AND description LIKE 'Required source role % is not covered by any fetched documents%'`;

      let sources = await withLinkedRunSources(sql, ctx.runId, sourceCorpus.sources);
      let coveredRoles = await recordSourceCoverage(sql, ctx.runId, sources, sourcePlan);

      // The collector decides when the corpus is sufficient for the specialists to start.
      const rounds: DiscoveryRound[] = [];
      for (let round = 1; round <= MAX_DISCOVERY_ROUNDS; round += 1) {
        // A failed review must not strand the run: the corpus goes forward with its gaps recorded.
        const review = await reviewSources(sql, ctx, sourcePlan, coveredRoles, sources, rounds).catch((error): SourceReview => ({
          sufficient: false, searches: [], accepted_gaps: [],
          assessment: `Collector review failed: ${error instanceof Error ? error.message : String(error)}`,
        }));
        const searches = review.sufficient ? [] : review.searches;
        if (!searches.length) {
          rounds.push({ ...review, round, searches: [] });
          break;
        }
        const results = await runSearches(sql, ctx, searches, TEAM_ROLES.data.agent);
        rounds.push({ ...review, round, searches: results });
        sources = await withLinkedRunSources(sql, ctx.runId, sourceCorpus.sources);
        coveredRoles = await recordSourceCoverage(sql, ctx.runId, sources, sourcePlan);
      }

      const final = rounds[rounds.length - 1];
      const notes = Object.fromEntries((final?.accepted_gaps || []).map(gap => [gap.source_role, gap.reason]));
      const { missingRoles, gaps } = await reconcileRoleGaps(sql, v2Ctx, sourcePlan, coveredRoles, notes);
      await saveReportArtifact(sql, ctx, "source_review", "discovery", {
        sufficient: Boolean(final?.sufficient), assessment: final?.assessment || "", rounds,
        covered_roles: [...coveredRoles], missing_required_roles: missingRoles,
      });

      return {
        status: "success",
        sourcesFetched: sources.filter(source => !source.sourceId.startsWith("candidate-")).length,
        coveredRoles: Array.from(coveredRoles),
        discoveryRounds: rounds.length,
        priceHistory: sourceCorpus.priceHistory,
        gaps: gaps.map((g: any) => g.gapKey),
      };
    } finally {
      await sql.end();
    }
  },
  async validate(ctx: ResearchRunContext, output: any): Promise<ValidationResult> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const rows = await sql`
        SELECT COUNT(DISTINCT sd.id) as cnt
        FROM source_documents sd
        LEFT JOIN research_run_sources rrs ON rrs.source_document_id = sd.id
        WHERE sd.research_run_id = ${ctx.runId} OR rrs.research_run_id = ${ctx.runId}
      `;
      const errors: string[] = [];
      if (Number(rows[0].cnt) === 0) {
        errors.push("No source documents ingested for this run");
      }
      return makeValidationResult(errors);
    } finally {
      await sql.end();
    }
  }
};
