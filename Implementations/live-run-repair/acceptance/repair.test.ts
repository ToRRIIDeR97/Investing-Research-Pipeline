import test from "node:test";
import assert from "node:assert/strict";
import { runRepairModule, repairStatements, needsStatementRepair } from "../../../src/lib/research/repair/statement-repair";
import { TEAM_ROLES, BRIEF_ROLES } from "../../../src/lib/research/team-plan";
import { ResearchRequest } from "../../../src/lib/research/team";
import { getAgentConfig } from "../../../src/lib/agent-harness/registry";
import { context, docId, fact, header, row, source, table, text } from "./fixtures";

// Statements labelled in Spanish with issuer-specific tags: neither headings nor
// us-gaap fingerprints identify them, so only the repair module can.
const spanishFiling = (id: string) => ({
  source: source(id, "2026-08-01", "2026-06-30"),
  html: header(2026, "Q2", "2026-06-30", context("i", "", "2026-06-30") + context("q", "2026-04-01", "2026-06-30")) +
    text("Balance general consolidado") +
    table(row("Activos totales", fact("i", "acme:ActivosTotales", "500")), row("Pasivos totales", fact("i", "acme:PasivosTotales", "300"))) +
    text("Estado de resultados consolidado") +
    table(row("Ingresos", fact("q", "acme:Ingresos", "90")), row("Utilidad neta", fact("q", "acme:UtilidadNeta", "9"))) +
    text("Estado de flujos de efectivo consolidado") +
    table(row("Flujo operativo", fact("q", "acme:FlujoOperativo", "20")), row("Flujo de inversion", fact("q", "acme:FlujoInversion", "-5"))),
});

const locateBySpanishHeading = `
function locateStatements(filings) {
  const patterns = { balance: /balance general/i, income: /estado de resultados/i, cashflow: /flujos de efectivo/i };
  const out = [];
  for (const filing of filings) for (const statement of filing.missing) {
    const match = filing.candidates.find(c => patterns[statement].test(c.preceding_text.join(" ")));
    if (match) out.push({ source_document_id: filing.source_document_id, table_index: match.table_index, statement });
  }
  return out;
}`;

test("AC-7: the repair specialist is registered, on demand, and cannot be requested by the report agent", () => {
  assert.equal(TEAM_ROLES.repair.agent, "repair-agent");
  assert.equal(TEAM_ROLES.repair.stage, "historical_record");
  assert.equal(getAgentConfig("repair-agent").name, "repair-agent");
  assert.ok(!BRIEF_ROLES.includes("repair"));
  assert.deepEqual([...BRIEF_ROLES].sort(), ["business", "data", "financials", "report", "valuation"]);
  assert.equal(ResearchRequest.safeParse({ role: "repair", question: "Repair the parser for this filing please",
    material: true, needs_sources: false, source_role: "regulatory_filing" }).success, false);
});

test("AC-8: complete captures never call the repair agent", async () => {
  const complete = { source: source(docId(40), "2026-08-01", "2026-06-30"),
    html: header(2026, "Q2", "2026-06-30", context("i", "", "2026-06-30") + context("q", "2026-04-01", "2026-06-30")) +
      text("Consolidated Balance Sheets") +
      table(row("Assets", fact("i", "us-gaap:Assets", "500")), row("Liabilities", fact("i", "us-gaap:Liabilities", "300")),
        row("Equity", fact("i", "us-gaap:StockholdersEquity", "200"))) +
      text("Consolidated Statements of Income") + table(row("Revenue", fact("q", "us-gaap:Revenues", "90"))) +
      text("Consolidated Statements of Cash Flows") + table(row("Operating", fact("q", "us-gaap:NetCashProvidedByUsedInOperatingActivities", "20"))) };
  let calls = 0;
  const result = await repairStatements({ filings: [complete], writeModule: async () => { calls++; return { module_source: locateBySpanishHeading, rationale: "unused" }; } });
  assert.equal(result.status, "not_needed");
  assert.equal(calls, 0);
  assert.equal(needsStatementRepair({ failures: [], coverage: [{ status: "extracted" }] }), false);
  assert.equal(needsStatementRepair({ failures: ["unreadable"], coverage: [{ status: "incomplete" }] }), false);
  assert.equal(needsStatementRepair({ failures: [], coverage: [{ status: "incomplete" }] }), true);
});

test("AC-9: the module runs without process, require, fetch or credentials and cannot hang", async () => {
  process.env.REPAIR_TEST_SECRET = "must-not-leak";
  const probe = await runRepairModule(`function locateStatements() {
    let escaped = "none";
    try { escaped = this.constructor.constructor("return process")().env.REPAIR_TEST_SECRET; } catch (e) { escaped = "blocked"; }
    return [typeof process, typeof require, typeof fetch, escaped];
  }`, []);
  assert.deepEqual(probe, { ok: true, output: ["undefined", "undefined", "undefined", "blocked"] });
  const hang = await runRepairModule("function locateStatements() { while (true) {} }", [], { timeoutMs: 500 });
  assert.equal(hang.ok, false);
  const thrown = await runRepairModule("function locateStatements() { throw new Error('bad parser'); }", []);
  assert.equal(thrown.ok, false);
  assert.match(thrown.ok ? "" : thrown.error, /bad parser/);
});

test("AC-10: a valid module repairs the filing and the extractor reads the tagged facts", async () => {
  const packets: any[] = [];
  const result = await repairStatements({ filings: [spanishFiling(docId(41))],
    writeModule: async packet => { packets.push(packet); return { module_source: locateBySpanishHeading, rationale: "Spanish headings" }; } });
  assert.equal(result.status, "repaired");
  assert.equal(packets.length, 1);
  assert.deepEqual(packets[0].filings[0].missing, ["income", "balance", "cashflow"]);
  assert.deepEqual(result.tables.map(t => [t.statement, t.identified_by]), [["balance", "repair"], ["income", "repair"], ["cashflow", "repair"]]);
  assert.equal(result.tables[1].rows[0].cells[1].facts[0].value, 90_000_000);
  assert.deepEqual(result.repaired_document_ids, [docId(41)]);
  assert.match(result.attempts[0].sha256, /^[0-9a-f]{64}$/);
});

test("AC-10: invalid locations are rejected and later attempts receive the errors", async () => {
  const modules = [
    "function locateStatements(f) { return [{ source_document_id: f[0].source_document_id, table_index: 999, statement: 'balance' }]; }",
    "function locateStatements(f) { return [{ source_document_id: 'unknown', table_index: 0, statement: 'income' }]; }",
    locateBySpanishHeading,
  ];
  const packets: any[] = [];
  const result = await repairStatements({ filings: [spanishFiling(docId(42))],
    writeModule: async packet => { packets.push(packet); return { module_source: modules[packets.length - 1], rationale: "attempt" }; } });
  assert.equal(result.status, "repaired");
  assert.equal(result.attempts.length, 3);
  assert.match(result.attempts[0].errors.join(" "), /table 999/);
  assert.match(result.attempts[1].errors.join(" "), /unknown/);
  assert.deepEqual(packets[2].previous_attempts.map((a: any) => a.errors.length > 0), [true, true]);
});

test("AC-10: repair stops after three attempts and reports the unresolved coverage", async () => {
  let calls = 0;
  const result = await repairStatements({ filings: [spanishFiling(docId(43))],
    writeModule: async () => { calls++; return { module_source: "function locateStatements() { return []; }", rationale: "nothing" }; } });
  assert.equal(result.status, "unresolved");
  assert.equal(calls, 3);
  assert.ok(result.coverage.some(c => c.status === "incomplete"));
});
