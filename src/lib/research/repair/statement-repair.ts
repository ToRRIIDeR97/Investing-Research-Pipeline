import { createHash } from "node:crypto";
import {
  extractFilingStatements, filingCoverage, reconcileFiledBalances, statementCandidates,
  type FilingSource, type FilingTable, type StatementCandidate, type StatementKind,
} from "../history/filing-statements";
import { runSandboxedModule, type SandboxResult } from "./sandbox";

export type RepairFiling = { source: FilingSource; html: string };
export type RepairFilingEntry = { source_document_id: string; form: string; period_end: string; missing: string[]; candidates: StatementCandidate[] };
export type ModulePacket = { contract: string; filings: RepairFilingEntry[]; previous_attempts: { attempt: number; errors: string[] }[] };
export type ModuleWriter = (packet: ModulePacket) => Promise<{ module_source: string; rationale: string }>;
export type RepairAttempt = { attempt: number; module_source: string; sha256: string; rationale: string; errors: string[]; outcome: "accepted" | "rejected" };
export type RepairResult = {
  status: "not_needed" | "repaired" | "unresolved";
  tables: FilingTable[];
  coverage: ReturnType<typeof filingCoverage>;
  reconciliation: ReturnType<typeof reconcileFiledBalances>;
  attempts: RepairAttempt[];
  repaired_document_ids: string[];
};

const STATEMENTS: StatementKind[] = ["balance", "income", "cashflow", "equity"];
export const MODULE_CONTRACT = [
  "Write plain JavaScript that defines function locateStatements(filings). No imports, require, network, files or timers exist.",
  "filings is an array of { source_document_id, form, period_end, missing, candidates }. Each candidate is { table_index, preceding_text, concepts, fact_count, row_labels, identified_as }.",
  "Return an array of { source_document_id, table_index, statement } where statement is balance, income, cashflow or equity. Locate every missing primary statement in every filing.",
  "Do not relabel candidates whose identified_as came from a heading. Never return numbers: values are read from the tagged facts of the tables you locate.",
  "Prefer general rules (heading words in any language, row labels, concept names) so one module handles every listed filing.",
].join(" ");

export const runRepairModule = (source: string, input: unknown, options?: { timeoutMs?: number }): Promise<SandboxResult> =>
  runSandboxedModule(source, input, options);

/** Repair only helps readable filings whose primary statements were not all located. */
export function needsStatementRepair(content: { failures: unknown[]; coverage: { status: string }[] }) {
  return content.failures.length === 0 && content.coverage.some(c => c.status === "incomplete");
}

function validateLocations(output: unknown, entries: RepairFilingEntry[], headingTables: Set<string>) {
  const errors: string[] = [];
  const overrides = new Map<string, Record<number, StatementKind>>();
  if (!Array.isArray(output)) return { overrides, errors: ["Module must return an array of locations"] };
  for (const [i, location] of output.entries()) {
    const { source_document_id: id, table_index: index, statement } = (location || {}) as Record<string, unknown>;
    const entry = entries.find(e => e.source_document_id === id);
    if (!entry) { errors.push(`Location ${i}: unknown source_document_id ${String(id)}`); continue; }
    if (!STATEMENTS.includes(statement as StatementKind)) { errors.push(`Location ${i}: invalid statement type "${String(statement)}"`); continue; }
    const candidate = entry.candidates.find(c => c.table_index === index);
    if (!candidate) { errors.push(`Location ${i}: document ${id} has no candidate table ${String(index)}`); continue; }
    if (headingTables.has(`${id}:${index}`)) {
      // A matching label adds nothing; a different one would override the filing's own heading.
      if (candidate.identified_as !== statement) errors.push(`Location ${i}: table ${index} in ${id} was identified by its heading as ${candidate.identified_as}; repair cannot relabel it`);
      continue;
    }
    overrides.set(String(id), { ...overrides.get(String(id)), [Number(index)]: statement as StatementKind });
  }
  return { overrides, errors };
}

/**
 * Deterministic extraction first; when statements are still missing, ask the repair specialist
 * for a run-scoped module that only locates tables. Values always come from the extractor.
 */
export async function repairStatements(params: { filings: RepairFiling[]; writeModule: ModuleWriter; maxAttempts?: number; timeoutMs?: number }): Promise<RepairResult> {
  const { filings, writeModule, maxAttempts = 3, timeoutMs = 5000 } = params;
  const sources = filings.map(f => f.source);
  const extract = (overrides = new Map<string, Record<number, StatementKind>>()) =>
    filings.flatMap(f => extractFilingStatements(f.html, f.source, overrides.get(f.source.id)));
  const tables = extract();
  const coverage = filingCoverage(tables, sources), reconciliation = reconcileFiledBalances(tables);
  const base = { tables, coverage, reconciliation, repaired_document_ids: [] as string[] };
  if (!needsStatementRepair({ failures: [], coverage })) return { status: "not_needed", attempts: [], ...base };

  const incomplete = new Set(coverage.filter(c => c.status === "incomplete").map(c => c.source_document_id));
  const entries: RepairFilingEntry[] = filings.filter(f => incomplete.has(f.source.id)).map(f => ({
    source_document_id: f.source.id, form: String(f.source.metadata_json.form || ""), period_end: f.source.period_end,
    missing: coverage.find(c => c.source_document_id === f.source.id)!.missing,
    candidates: statementCandidates(f.html, tables.filter(t => t.source_document_id === f.source.id)) }));
  const headingTables = new Set(tables.filter(t => t.identified_by === "heading").map(t => `${t.source_document_id}:${t.table_index}`));
  const attempts: RepairAttempt[] = [];
  for (let n = 1; n <= maxAttempts; n++) {
    // Model-call failures (budget, authentication, provider) propagate like any agent call.
    const written = await writeModule({ contract: MODULE_CONTRACT, filings: entries,
      previous_attempts: attempts.map(a => ({ attempt: a.attempt, errors: a.errors })) });
    const source = String(written?.module_source ?? "");
    const attempt: RepairAttempt = { attempt: n, module_source: source, sha256: createHash("sha256").update(source).digest("hex"),
      rationale: String(written?.rationale ?? ""), errors: [], outcome: "rejected" };
    attempts.push(attempt);
    const run = await runRepairModule(source, entries, { timeoutMs });
    if (!run.ok) { attempt.errors.push(`Module failed: ${run.error}`); continue; }
    const { overrides, errors } = validateLocations(run.output, entries, headingTables);
    if (errors.length) { attempt.errors.push(...errors); continue; }
    const repaired = extract(overrides);
    const repairedCoverage = filingCoverage(repaired, sources), repairedReconciliation = reconcileFiledBalances(repaired);
    attempt.errors.push(
      ...repairedCoverage.filter(c => c.status === "incomplete").map(c =>
        `Document ${c.source_document_id} is still incomplete: missing ${c.missing.join(", ") || "none"}, ${c.unresolved_facts} unresolved facts`),
      ...repairedReconciliation.filter(r => r.status === "mismatch").map(r =>
        `Balance sheet in ${r.source_document_id} at ${r.period_end} does not reconcile (${r.check}; difference ${r.difference})`));
    if (attempt.errors.length) continue;
    attempt.outcome = "accepted";
    return { status: "repaired", tables: repaired, coverage: repairedCoverage, reconciliation: repairedReconciliation, attempts,
      repaired_document_ids: [...overrides.keys()] };
  }
  return { status: "unresolved", attempts, ...base };
}
