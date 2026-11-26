/**
 * Read-only replay of a stored run's analysis-stage calls through the packet cap (src/lib/research/call-packet.ts):
 * prints each call's prompt bytes and estimated input tokens as sent, and after the cap, with what the cap left out.
 *
 * Usage: DATABASE_URL=... npx tsx scripts/analysis-packet-size.ts <run-id> [--all]
 * Each task row stores the packet a call sent and the instructions before it. Tokens are estimated from bytes with
 * the task type's logged ratio (input tokens ÷ input bytes, single-pass attempts only: a repair pass adds a second
 * request to the same log row). Without --all, only the largest call of each task key is printed. Operating-model
 * packets get their reported history rebuilt from the run's historical_record with the current handler code, so a
 * run stored before that shape changed replays as it would run now. Nothing is written.
 */
import postgres from "postgres";
import { ANALYSIS_PACKET_STAGES, CAPPED_PACKET_RULE, fitCallPacket } from "../src/lib/research/call-packet";
import { recentByMetric } from "../src/lib/research/handlers/operating-model";

const runId = process.argv[2];
if (!runId || !process.env.DATABASE_URL) throw new Error("Usage: DATABASE_URL=... tsx scripts/analysis-packet-size.ts <run-id> [--all]");
const showAll = process.argv.includes("--all");
const sql = postgres(process.env.DATABASE_URL, { max: 2 });
const THRESHOLD = 100_000;
/** perCallKeys as the calls pass them: team answers (team.ts ownerAnswer). Stage calls pass none. */
const PER_CALL_KEYS: Record<string, string[]> = { team_answer: ["request", "source_search_attempted", "passages"] };
const bytes = (value: unknown) => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value ?? null));

async function main() {
  const tasks = await sql`SELECT t.id, s.stage_key, t.task_type, t.task_key, t.input_json FROM research_tasks t
    JOIN research_stages s ON s.id = t.stage_id WHERE t.research_run_id = ${runId} ORDER BY t.created_at`;
  const logs = await sql`SELECT t.task_type, m.input_tokens, (m.request_metadata_json->>'input_bytes')::float AS input_bytes
    FROM model_call_logs m JOIN research_tasks t ON t.id = m.task_id
    WHERE m.research_run_id = ${runId} AND m.input_tokens > 0 AND m.request_metadata_json ? 'input_bytes'`;
  const ratios = new Map<string, number>();
  for (const row of logs) {
    const ratio = Number(row.input_tokens) / Number(row.input_bytes);
    if (ratio < 0.7) ratios.set(String(row.task_type), Math.max(ratios.get(String(row.task_type)) ?? 0, ratio));
  }
  const fallback = Math.max(...ratios.values(), 0.48);
  // The operating-model handler's history fields, as it builds them now.
  const [record] = await sql`SELECT content_json->'observations' AS observations FROM research_artifacts WHERE research_run_id = ${runId}
    AND artifact_type = 'historical_record' AND status IN ('validated', 'accepted') ORDER BY created_at DESC LIMIT 1`;
  const history: Array<Record<string, any>> = Array.isArray(record?.observations) ? record.observations : [];
  const segmentRows = history.filter((o) => o.segment && o.metadata_json?.statement === "segment");
  const operatingHistory = { recent_reported_history: recentByMetric(history.filter((o) => !o.segment), 6),
    reported_segment_history: Object.fromEntries([...new Set(segmentRows.map((o) => String(o.segment)))].map((segment) =>
      [segment, recentByMetric(segmentRows.filter((o) => o.segment === segment), 8)])) };
  const rows: Array<Record<string, any>> = [];
  for (const task of tasks) {
    if (!ANALYSIS_PACKET_STAGES.has(String(task.stage_key))) continue;
    const input = task.input_json as Record<string, any>;
    if (!input?.packet || typeof input.prompt_instructions !== "string") continue;
    const ratio = ratios.get(String(task.task_type)) ?? fallback;
    const before = bytes(input.prompt_instructions) + bytes(input.packet);
    const packet = task.task_type === "operating_model" && history.length ? { ...input.packet, ...operatingHistory } : input.packet;
    const fitted = fitCallPacket(packet, PER_CALL_KEYS[String(task.task_type)]) as Record<string, any>;
    const capped = fitted !== packet;
    const after = bytes(input.prompt_instructions) + bytes(fitted) + (capped ? bytes(CAPPED_PACKET_RULE) + 1 : 0);
    const omittedFields = [...(fitted.artifacts ?? []), ...(fitted.team_context?.upstream_artifacts ?? [])]
      .filter((a: any) => a?.omitted_fields || a?.content_in).map((a: any) => a.content_in ? `${a.artifact_type}→${a.content_in}` : `${a.artifact_type}(-${a.omitted_fields.length})`);
    rows.push({ stage: task.stage_key, type: task.task_type, key: String(task.task_key).replace(/:[0-9a-f]{20,}$/, ""), ratio,
      before, after, beforeTokens: Math.round(before * ratio), afterTokens: Math.round(after * ratio),
      rebuilt: packet !== input.packet ? bytes(input.prompt_instructions) + bytes(packet) : null,
      cap: capped ? { ...fitted.packet_cap, artifacts: omittedFields } : null });
  }
  const shown = showAll ? rows : [...rows.reduce((map, row) => {
    const kept = map.get(row.key);
    if (!kept || row.before > kept.before) map.set(row.key, row);
    return map;
  }, new Map<string, Record<string, any>>()).values()];
  console.log("stage\ttask\tbytes_before\ttokens_before\tbytes_after\ttokens_after\tratio\tcap (rebuilt: bytes in the current handler shape, before the cap)");
  for (const row of shown.sort((a, b) => b.beforeTokens - a.beforeTokens))
    console.log([row.stage, row.key.slice(0, 40), row.before, row.beforeTokens, row.after, row.afterTokens, row.ratio.toFixed(3),
      (row.rebuilt ? `rebuilt=${row.rebuilt} ` : "") + (row.cap ? JSON.stringify(row.cap) : "unchanged")].join("\t"));
  const over = rows.filter(row => row.afterTokens >= THRESHOLD);
  const peak = rows.reduce((max, row) => Math.max(max, row.afterTokens), 0);
  console.log(`\n${rows.length} analysis calls; ${rows.filter(r => r.beforeTokens >= THRESHOLD).length} were over ${THRESHOLD} tokens, ${over.length} are after the cap; peak after ${peak}.`);
  await sql.end();
  if (over.length) process.exitCode = 1;
}

main().catch(async (error) => { console.error(error); await sql.end(); process.exit(1); });
