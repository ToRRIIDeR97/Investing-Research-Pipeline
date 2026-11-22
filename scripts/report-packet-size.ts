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
import { COVERAGE, storedSection } from "../src/lib/research/reporting/contracts";
import { cleanReaderFields } from "../src/lib/research/reporting/reader-prose";
import { checkReportSubstance } from "../src/lib/research/reporting/substance";
import { writeFileSync } from "node:fs";
import { buildExhibits, isAvailable, placeExhibits } from "../src/lib/research/reporting/exhibits";
import { reportEvidenceView, reportSectionCall, splitReportArtifacts } from "../src/lib/research/reporting/runtime";
import { buildReportFacts } from "../src/lib/research/reporting/facts";
import { mergeObservations } from "../src/lib/research/reporting/data-views";
import { FinancialAnalytics, buildFinancialAnalytics } from "../src/lib/research/history/analytics";
import { buildStatementSummary } from "../src/lib/research/history/statement-summary";
import { getTeamRequests } from "../src/lib/research/team";
import { citationRefs } from "../src/lib/research/reporting/refs";

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
  // Like the runtime: report packets carry citation tokens, applied to the finished packet.
  const refs = citationRefs(artifacts, inputs.evidence);
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
  const prepared = new Map<string, { section: any; params: Awaited<ReturnType<typeof prepareResearchCall>>["params"]; contract: any; stored: any }>();
  // Like the runtime: body chapters first, then each conclusion reads every section before it; the last returns coverage.
  const isConclusion = (s: any) => s.coverage?.includes("conclusion");
  const completed: any[] = (document?.sections ?? []).filter((s: any) => !isConclusion(s));
  const lastConclusion = outline.sections.filter(isConclusion).at(-1)?.id;
  // Like the runtime: code builds the exhibits once and places them in the outline's chapters.
  const exhibits = buildExhibits(artifacts, { cutoff: ctx.cutoffAt.toISOString() });
  const placement = placeExhibits(outline.sections, exhibits);
  const placedIn = (id: string) => (placement[id] ?? []).flatMap((key) => exhibits.filter(isAvailable).filter((e) => e.key === key));
  for (const section of [...outline.sections.filter((s: any) => !isConclusion(s)), ...outline.sections.filter(isConclusion)]) {
    const call = reportSectionCall(common, packetArtifacts, section, outline, [], isConclusion(section) ? [...completed] : [],
      section.id === lastConclusion ? outline.coverage : undefined, placedIn(section.id));
    const { params } = await prepareResearchCall({ sql, ctx, stageKey: "report_draft", taskKey: `report:section:${section.id}`, taskType: "report_section",
      agentName: "export-writer", modelTier: "mid", packet: call.packet, perCallKeys: call.perCallKeys, packetTransform: refs.packet,
      promptFactory: (p) => exactJsonPrompt({ agentName: "export-writer", requiredKeys: call.contract.requiredKeys, packet: p, extraRules: call.extraRules }) });
    const written = (document?.sections ?? []).find((s: any) => s.id === section.id);
    if (isConclusion(section) && written) completed.push(written);
    // The stored section to compare a replay with: the same id, else (for a conclusion of a newer outline) the stored
    // report's conclusion in the same position.
    const storedConclusions = (document?.sections ?? []).filter(isConclusion);
    const position = outline.sections.filter(isConclusion).findIndex((s: any) => s.id === section.id);
    const stored = written ?? (isConclusion(section) && position >= 0 ? storedConclusions[position] ?? null : null);
    prepared.set(section.id, { section, params, contract: call.contract, stored });
    const bytes = Buffer.byteLength(params.promptFactory!(params.packet));
    const tokens = Math.round(bytes * ratio);
    worst = Math.max(worst, tokens);
    const keys = Object.entries(params.packet).map(([k, v]) => [k, Buffer.byteLength(JSON.stringify(v ?? null))] as const)
      .sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, b]) => `${k} ${(b / 1024).toFixed(0)}`).join(", ");
    const before = Math.max(0, ...logged.filter((r) => String(r.task_key).startsWith(`report:section:${section.id}:`)).map((r) => Number(r.input_tokens)));
    console.log([section.id, bytes, tokens, before || "-", keys].join("\t"));
  }
  console.log(`Largest estimated report-section prompt: ${worst} tokens`);
  if (live.length) await sendLive(live, prepared, refs);
}

/**
 * Sends the named sections to the provider and checks each output the way the report runtime does, minus the full-report
 * assembly: each section's own contract (a conclusion's includes key_reasons), then the runtime's resolve-and-clean step.
 * Prints each section's key reasons and the reader-language findings (checkReportSubstance) of the replayed section next to
 * the stored one. --out <file> also writes the cleaned answers as JSON. Nothing is written to the database.
 */
async function sendLive(ids: string[], prepared: Map<string, { section: any; params: any; contract: any; stored: any }>, refs: ReturnType<typeof citationRefs>) {
  const scope = `report-replay-${randomUUID()}`;
  const rows: Record<string, unknown>[] = [];
  const outputs: Record<string, any>[] = [];
  for (const id of ids) {
    const entry = prepared.get(id);
    if (!entry) throw new Error(`No section ${id} in the outline`);
    const { section, params, contract } = entry;
    let attempts: AgentAttempt[] = [], status = "pass", error = "";
    try {
      const result = await runResearchAgent<{ section: any; coverage?: unknown }>({ agentName: params.agentName, title: `report replay ${id}`, taskPacket: params.packet,
        promptFactory: params.promptFactory, perCallKeys: params.perCallKeys, cacheScope: scope,
        outputFormat: { ...contract, validate(value: any) {
          const errors = contract.validate?.(value) || [];
          if (errors.length) return errors;
          if (value.section.id !== section.id || JSON.stringify(value.section.coverage) !== JSON.stringify(section.coverage)) return [{ path: "section", message: "Preserve section id and coverage exactly" }];
          return [];
        } } });
      attempts = result.attempts;
      const cleaned = cleanReaderFields(refs.resolve(result.structured)) as { section: any };
      const replayed = storedSection(cleaned.section, []);
      const findings = (s: any) => s ? checkReportSubstance([{ ...s, tables: s.tables ?? [], gaps: s.gaps ?? [] }]).map((f) => f.issue) : [];
      outputs.push({ section: id, key_reasons: replayed.key_reasons ?? [], implication: replayed.implication,
        findings_replayed: findings(replayed), findings_stored: findings(entry.stored), answer: cleaned });
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
  for (const o of outputs) {
    console.log(`
== ${o.section}: ${o.key_reasons.length} key reasons; reader-language findings replayed ${o.findings_replayed.length} vs stored ${o.findings_stored.length}`);
    for (const r of o.key_reasons) console.log(`- ${r.headline} [${r.figure}] (${r.evidence_ids.length} sources)
  ${r.explanation}`);
    for (const f of o.findings_replayed) console.log(`  finding: ${f}`);
  }
  const outAt = process.argv.indexOf("--out");
  if (outAt > 0 && process.argv[outAt + 1]) writeFileSync(process.argv[outAt + 1], JSON.stringify(outputs, null, 2));
  const passes = rows.filter((r) => "cost_usd" in r);
  console.log(JSON.stringify({ calls: passes.length, cost_usd: Number(passes.reduce((n, r) => n + Number(r.cost_usd), 0).toFixed(6)) }));
}

main().finally(() => sql.end());
