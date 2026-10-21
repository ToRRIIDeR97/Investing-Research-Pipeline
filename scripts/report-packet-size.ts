/**
 * Read-only replay of a stored run's report-section prompts with the current packet code: prints each section's
 * prompt bytes, estimated tokens and largest packet keys, next to the input tokens the run logged. Runs that
 * predate financial_analytics get it, the statement summary and report_facts computed in memory.
 *
 * Usage: DATABASE_URL=... npx tsx scripts/report-packet-size.ts <run-id>
 * Tokens are estimated from bytes with the run's own logged report-section ratio (input tokens ÷ input bytes).
 */
import postgres from "postgres";
import { exactJsonPrompt, loadRunContext, prepareResearchCall } from "../src/lib/research/run-context";
import { loadReportInputs } from "../src/lib/research/reporting/store";
import { COVERAGE, RESEARCH_DOCTRINE, SECTION_CONTRACT } from "../src/lib/research/reporting/contracts";
import { REPORT_FACTS_RULE, SECTION_RULES, conclusionInputs, reportEvidenceView, splitReportArtifacts } from "../src/lib/research/reporting/runtime";
import { buildReportFacts } from "../src/lib/research/reporting/facts";
import { mergeObservations } from "../src/lib/research/reporting/data-views";
import { VISUAL_GUIDELINES } from "../src/lib/research/reporting/visuals";
import { FinancialAnalytics, buildFinancialAnalytics } from "../src/lib/research/history/analytics";
import { buildStatementSummary } from "../src/lib/research/history/statement-summary";
import { getTeamRequests } from "../src/lib/research/team";

const runId = process.argv[2];
if (!runId || !process.env.DATABASE_URL) throw new Error("Usage: DATABASE_URL=... tsx scripts/report-packet-size.ts <run-id>");
const sql = postgres(process.env.DATABASE_URL, { max: 2 });
const latest = async (type: string) => (await sql`SELECT id, content_json FROM research_artifacts WHERE research_run_id = ${runId}
  AND artifact_type = ${type} ORDER BY artifact_version DESC, created_at DESC LIMIT 1`)[0] ?? null;

async function main() {
  const ctx = await loadRunContext(sql, runId);
  const inputs = await loadReportInputs(sql, runId, ctx.cutoffAt.toISOString());
  const artifacts: any[] = [...inputs.artifacts];
  const synthetic = (type: string, content: unknown) => artifacts.push({ id: `replay-${type}`, artifact_type: type, scope_key: type, artifact_version: 1, content_json: content });
  if (!artifacts.some((a) => a.artifact_type === "financial_analytics")) {
    const set = (await latest("financial_statement_set"))?.content_json;
    const market = (await latest("market_price_history"))?.content_json;
    const record = artifacts.find((a) => a.artifact_type === "historical_record")?.content_json;
    if (!set) throw new Error("The run has no financial_statement_set");
    const end = [...set.tables].filter((t: any) => t.statement !== "segment").sort((a: any, b: any) => a.period_end.localeCompare(b.period_end)).at(-1);
    const pack = FinancialAnalytics.parse(buildFinancialAnalytics({ observations: mergeObservations(set.observations, record?.observations ?? [], market?.observations ?? []),
      endFiscalYear: end.fiscal_year, endFiscalQuarter: end.fiscal_quarter }));
    synthetic("financial_analytics", pack);
    synthetic("financial_statement_summary", buildStatementSummary(set, pack.quarterly.rows.map((row) => String(row[0]))));
  }
  if (!artifacts.some((a) => a.artifact_type === "report_facts")) synthetic("report_facts", buildReportFacts(artifacts));
  const { shared, packetArtifacts } = splitReportArtifacts(artifacts);
  const teamRequests = await getTeamRequests(sql, runId);
  const [run] = await sql`SELECT metadata_json FROM research_runs WHERE id = ${runId}`;
  const common = { asset: { assetName: ctx.assetName, symbol: ctx.symbol, profile: ctx.profileKey },
    research_question: ctx.researchQuestion, source_cutoff: ctx.cutoffAt.toISOString(),
    coverage_requirements: COVERAGE, ...shared, artifacts: packetArtifacts, evidence_claims: reportEvidenceView(inputs.evidence), specialist_requests: teamRequests?.requests || [],
    human_revision_request: run?.metadata_json?.report_revision_request || null };

  const outlineContent = (await latest("report_outline"))?.content_json;
  const outline = outlineContent?.outline ?? outlineContent;
  const document = (await latest("report_document"))?.content_json;
  const logged = await sql`SELECT t.task_key, l.input_tokens, (l.request_metadata_json->>'input_bytes')::bigint AS bytes FROM model_call_logs l
    JOIN research_tasks t ON t.id = l.task_id WHERE l.research_run_id = ${runId} AND t.task_type = 'report_section' AND l.status = 'success'`;
  const ratio = logged.reduce((n, r) => n + Number(r.input_tokens), 0) / logged.reduce((n, r) => n + Number(r.bytes), 0);
  console.log(`Calibration: ${ratio.toFixed(3)} tokens/byte from ${logged.length} logged report-section calls`);
  console.log(["section", "bytes", "est_tokens", "logged_tokens_max", "largest keys (KB)"].join("\t"));
  let worst = 0;
  for (const section of outline.sections) {
    const selected = packetArtifacts.filter((a) => section.artifact_ids.includes(a.id));
    const conclusion = section.coverage.includes("conclusion")
      ? conclusionInputs((document?.sections ?? []).filter((s: any) => !s.coverage?.includes("conclusion")), common.evidence_claims) : null;
    const packet = { ...common, ...(conclusion ? { evidence_claims: conclusion.evidence, filing_passages: [] } : {}),
      artifacts: selected.length ? selected : packetArtifacts, section_plan: section, outline, feedback: [],
      completed_sections: conclusion?.chapters ?? [], visual_guidelines: VISUAL_GUIDELINES, output_contract: "report_section", output_schema: SECTION_CONTRACT.schema };
    const { params } = await prepareResearchCall({ sql, ctx, stageKey: "ai_reviewer", taskKey: `report:section:${section.id}`, taskType: "report_section",
      agentName: "export-writer", modelTier: "mid", packet, perCallKeys: ["artifacts", "section_plan", "completed_sections"],
      promptFactory: (p) => exactJsonPrompt({ agentName: "export-writer", requiredKeys: ["section"], packet: p, extraRules: [...RESEARCH_DOCTRINE, REPORT_FACTS_RULE, ...SECTION_RULES] }) });
    const bytes = Buffer.byteLength(params.promptFactory!(params.packet));
    const tokens = Math.round(bytes * ratio);
    worst = Math.max(worst, tokens);
    const keys = Object.entries(params.packet).map(([k, v]) => [k, Buffer.byteLength(JSON.stringify(v ?? null))] as const)
      .sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, b]) => `${k} ${(b / 1024).toFixed(0)}`).join(", ");
    const before = Math.max(0, ...logged.filter((r) => String(r.task_key).startsWith(`report:section:${section.id}:`)).map((r) => Number(r.input_tokens)));
    console.log([section.id, bytes, tokens, before || "-", keys].join("\t"));
  }
  console.log(`Largest estimated report-section prompt: ${worst} tokens`);
}

main().finally(() => sql.end());
