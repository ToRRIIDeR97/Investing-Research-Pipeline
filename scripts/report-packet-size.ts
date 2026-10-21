/**
 * Read-only replay of a stored run's report-section prompts with the current packet code: prints each section's
 * prompt bytes, estimated tokens and largest packet keys, next to the input tokens the run logged. Runs that
 * predate financial_analytics get it, the statement summary and report_facts computed in memory.
 *
 * Usage: DATABASE_URL=... npx tsx scripts/report-packet-size.ts <run-id> [--live section-id,section-id]
 * Tokens are estimated from bytes with the run's own logged report-section ratio (input tokens ÷ input bytes).
 * --live (paid, needs RUN_PAID_RESEARCH=1) also sends the named sections, in order, to the configured provider
 * under one cache scope and prints usage, cost and whether each output passes the section contract. Nothing is
 * written to the database.
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { runResearchAgent } from "../src/lib/agent-harness/runner";
import { ResearchAgentRunError } from "../src/lib/agent-harness/errors";
import type { AgentAttempt } from "../src/lib/agent-harness/types";
import { exactJsonPrompt, loadRunContext, prepareResearchCall } from "../src/lib/research/run-context";
import { loadReportInputs } from "../src/lib/research/reporting/store";
import { COVERAGE, SECTION_CONTRACT, validateChartPlan } from "../src/lib/research/reporting/contracts";
import { reportEvidenceView, reportSectionCall, splitReportArtifacts } from "../src/lib/research/reporting/runtime";
import { buildReportFacts } from "../src/lib/research/reporting/facts";
import { mergeObservations } from "../src/lib/research/reporting/data-views";
import { FinancialAnalytics, buildFinancialAnalytics } from "../src/lib/research/history/analytics";
import { buildStatementSummary } from "../src/lib/research/history/statement-summary";
import { getTeamRequests } from "../src/lib/research/team";

const runId = process.argv[2];
if (!runId || !process.env.DATABASE_URL) throw new Error("Usage: DATABASE_URL=... tsx scripts/report-packet-size.ts <run-id> [--live section-id,...]");
const live = process.argv.includes("--live") ? String(process.argv[process.argv.indexOf("--live") + 1] ?? "").split(",").filter(Boolean) : [];
if (live.length && process.env.RUN_PAID_RESEARCH !== "1") throw new Error("--live sends paid model calls: set RUN_PAID_RESEARCH=1");
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
  const prepared = new Map<string, { section: any; params: Awaited<ReturnType<typeof prepareResearchCall>>["params"] }>();
  // Like the runtime: body chapters first, then each conclusion reads every section before it; the last returns coverage.
  const isConclusion = (s: any) => s.coverage?.includes("conclusion");
  const completed: any[] = (document?.sections ?? []).filter((s: any) => !isConclusion(s));
  const lastConclusion = outline.sections.filter(isConclusion).at(-1)?.id;
  for (const section of [...outline.sections.filter((s: any) => !isConclusion(s)), ...outline.sections.filter(isConclusion)]) {
    const call = reportSectionCall(common, packetArtifacts, section, outline, [], isConclusion(section) ? [...completed] : [],
      section.id === lastConclusion ? outline.coverage : undefined);
    const { params } = await prepareResearchCall({ sql, ctx, stageKey: "ai_reviewer", taskKey: `report:section:${section.id}`, taskType: "report_section",
      agentName: "export-writer", modelTier: "mid", packet: call.packet, perCallKeys: call.perCallKeys,
      promptFactory: (p) => exactJsonPrompt({ agentName: "export-writer", requiredKeys: call.contract.requiredKeys, packet: p, extraRules: call.extraRules }) });
    const written = (document?.sections ?? []).find((s: any) => s.id === section.id);
    if (isConclusion(section) && written) completed.push(written);
    prepared.set(section.id, { section, params });
    const bytes = Buffer.byteLength(params.promptFactory!(params.packet));
    const tokens = Math.round(bytes * ratio);
    worst = Math.max(worst, tokens);
    const keys = Object.entries(params.packet).map(([k, v]) => [k, Buffer.byteLength(JSON.stringify(v ?? null))] as const)
      .sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, b]) => `${k} ${(b / 1024).toFixed(0)}`).join(", ");
    const before = Math.max(0, ...logged.filter((r) => String(r.task_key).startsWith(`report:section:${section.id}:`)).map((r) => Number(r.input_tokens)));
    console.log([section.id, bytes, tokens, before || "-", keys].join("\t"));
  }
  console.log(`Largest estimated report-section prompt: ${worst} tokens`);
  if (live.length) await sendLive(live, prepared);
}

/** Sends the named sections to the provider and checks each output the way the report runtime does, minus the full-report assembly. */
async function sendLive(ids: string[], prepared: Map<string, { section: any; params: any }>) {
  const scope = `report-replay-${randomUUID()}`;
  const rows: Record<string, unknown>[] = [];
  for (const id of ids) {
    const entry = prepared.get(id);
    if (!entry) throw new Error(`No section ${id} in the outline`);
    const { section, params } = entry;
    let attempts: AgentAttempt[] = [], status = "pass", error = "";
    try {
      const result = await runResearchAgent<{ section: any }>({ agentName: params.agentName, title: `report replay ${id}`, taskPacket: params.packet,
        promptFactory: params.promptFactory, perCallKeys: params.perCallKeys, cacheScope: scope,
        outputFormat: { ...SECTION_CONTRACT, validate(value: any) {
          const errors = SECTION_CONTRACT.validate?.(value) || [];
          if (errors.length) return errors;
          if (value.section.id !== section.id || JSON.stringify(value.section.coverage) !== JSON.stringify(section.coverage)) return [{ path: "section", message: "Preserve section id and coverage exactly" }];
          try { validateChartPlan(section, value.section); return []; } catch (e) { return [{ path: "section", message: String(e) }]; }
        } } });
      attempts = result.attempts;
    } catch (e) {
      status = "fail";
      error = e instanceof Error ? e.message.slice(0, 200) : String(e);
      if (e instanceof ResearchAgentRunError) attempts = e.attempts;
    }
    for (const attempt of attempts) for (const pass of attempt.passes ?? []) rows.push({ section: id, model: attempt.model, pass: pass.kind,
      status: pass.status, input: pass.inputTokens, cache_read: pass.cacheReadTokens ?? 0, cache_write: pass.cacheWriteTokens ?? 0,
      output: pass.outputTokens, cost_usd: pass.costUsd, latency_s: Math.round(pass.latencyMs / 1000), errors: (pass.validationErrors ?? []).slice(0, 2) });
    rows.push({ section: id, result: status, attempts: attempts.length, ...(error ? { error } : {}) });
  }
  console.log(JSON.stringify(rows, null, 2));
  const passes = rows.filter((r) => "cost_usd" in r);
  console.log(JSON.stringify({ calls: passes.length, cost_usd: Number(passes.reduce((n, r) => n + Number(r.cost_usd), 0).toFixed(6)) }));
}

main().finally(() => sql.end());
