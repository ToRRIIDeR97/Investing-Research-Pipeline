import test from "node:test";
import assert from "node:assert/strict";
import { repairStatements } from "../../../src/lib/research/repair/statement-repair";
import { TEAM_ROLES } from "../../../src/lib/research/team-plan";
import { getAgentConfig } from "../../../src/lib/agent-harness/registry";

// Independent fixtures: a German-language filing, two filings, and a decoy table.
const id = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
const filing = (n: number, body: string) => ({
  source: { id: id(n), url: `https://sec.example/${n}`, published_at: "2025-08-05", period_end: "2025-06-30", metadata_json: { form: "10-Q" } },
  html: `<ix:nonNumeric name="dei:DocumentFiscalYearFocus">2025</ix:nonNumeric><ix:nonNumeric name="dei:DocumentFiscalPeriodFocus">Q2</ix:nonNumeric><ix:nonNumeric name="dei:DocumentPeriodEndDate">2025-06-30</ix:nonNumeric><xbrli:unit id="u"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit><xbrli:context id="i"><xbrli:period><xbrli:instant>2025-06-30</xbrli:instant></xbrli:period></xbrli:context><xbrli:context id="d"><xbrli:period><xbrli:startDate>2025-04-01</xbrli:startDate><xbrli:endDate>2025-06-30</xbrli:endDate></xbrli:period></xbrli:context>${body}`,
});
const f = (c: string, name: string, v: string) => `<ix:nonFraction name="${name}" contextRef="${c}" unitRef="u">${v}</ix:nonFraction>`;
const tbl = (...cells: [string, string][]) => `<table>${cells.map(([l, v]) => `<tr><td>${l}</td><td>${v}</td></tr>`).join("")}</table>`;
const p = (t: string) => `<p>${t}</p>`;
const german = (n: number) => filing(n, p("Konzernbilanz") + tbl(["Aktiva", f("i", "de:Aktiva", "7")]) +
  p("Konzern-Gewinn- und Verlustrechnung") + tbl(["Umsatz", f("d", "de:Umsatz", "3")]) +
  p("Konzern-Kapitalflussrechnung") + tbl(["Operativ", f("d", "de:Operativ", "1")]));
const germanModule = `function locateStatements(filings) {
  const words = { balance: /bilanz/i, income: /gewinn/i, cashflow: /kapitalfluss/i };
  const out = [];
  for (const filing of filings) for (const statement of filing.missing) {
    const hit = filing.candidates.find(c => words[statement].test(c.preceding_text.join(" ")));
    if (hit) out.push({ source_document_id: filing.source_document_id, table_index: hit.table_index, statement });
  }
  return out;
}`;

test("AC-7: the repair agent uses a configured model route and exposes its purpose", () => {
  assert.ok(getAgentConfig("repair-agent").modelEnvVar);
  assert.match(TEAM_ROLES.repair.purpose, /module|parser|repair/i);
});

test("AC-10: one module repairs every incomplete filing and candidates describe the tables", async () => {
  let packet: any;
  const result = await repairStatements({ filings: [german(1), german(2)], writeModule: async p => { packet = p; return { module_source: germanModule, rationale: "German headings" }; } });
  assert.equal(result.status, "repaired");
  assert.deepEqual(result.repaired_document_ids.sort(), [id(1), id(2)]);
  const candidate = packet.filings[0].candidates[0];
  assert.deepEqual(Object.keys(candidate).sort(), ["concepts", "fact_count", "identified_as", "preceding_text", "row_labels", "table_index"]);
  assert.deepEqual(candidate.concepts, ["de:Aktiva"]);
  assert.equal(candidate.identified_as, null);
});

test("AC-10: heading-identified tables cannot be relabelled and invalid statement types are rejected", async () => {
  const withHeading = filing(3, p("Consolidated Statements of Income") + tbl(["Revenue", f("d", "us-gaap:Revenues", "3")]) +
    p("Konzernbilanz") + tbl(["Aktiva", f("i", "de:Aktiva", "7")]) + p("Kapitalflussrechnung") + tbl(["Operativ", f("d", "de:Operativ", "1")]));
  const modules = [
    `function locateStatements(f) { return [{ source_document_id: f[0].source_document_id, table_index: f[0].candidates[0].table_index, statement: 'balance' }]; }`,
    `function locateStatements(f) { return [{ source_document_id: f[0].source_document_id, table_index: f[0].candidates[1].table_index, statement: 'notes' }]; }`,
    `function locateStatements(f) { return 'not an array'; }`,
  ];
  let n = 0;
  const result = await repairStatements({ filings: [withHeading], writeModule: async () => ({ module_source: modules[n++], rationale: "bad" }) });
  assert.equal(result.status, "unresolved");
  assert.match(result.attempts[0].errors.join(" "), /heading/i);
  assert.match(result.attempts[1].errors.join(" "), /notes/);
  assert.ok(result.attempts[2].errors.length > 0);
  assert.equal(result.attempts.length, 3);
});

test("AC-10: a relabelled decoy that breaks balance reconciliation fails the attempt", async () => {
  const body = p("Consolidated Balance Sheets") + tbl(["Assets", f("i", "us-gaap:Assets", "10")], ["Liabilities", f("i", "us-gaap:Liabilities", "6")],
      ["Equity", f("i", "us-gaap:StockholdersEquity", "4")]) +
    p("Liquidity note") + tbl(["Assets", f("i", "us-gaap:Assets", "10")], ["Liabilities", f("i", "us-gaap:Liabilities", "9")],
      ["Equity", f("i", "us-gaap:StockholdersEquity", "4")]) +
    p("Konzern-Gewinn- und Verlustrechnung") + tbl(["Umsatz", f("d", "de:Umsatz", "3")]) +
    p("Konzern-Kapitalflussrechnung") + tbl(["Operativ", f("d", "de:Operativ", "1")]);
  const decoy = `function locateStatements(f) { const c = f[0].candidates;
    return [{ source_document_id: f[0].source_document_id, table_index: c[1].table_index, statement: 'balance' },
      { source_document_id: f[0].source_document_id, table_index: c[2].table_index, statement: 'income' },
      { source_document_id: f[0].source_document_id, table_index: c[3].table_index, statement: 'cashflow' }]; }`;
  const honest = `function locateStatements(f) { const c = f[0].candidates;
    return [{ source_document_id: f[0].source_document_id, table_index: c[2].table_index, statement: 'income' },
      { source_document_id: f[0].source_document_id, table_index: c[3].table_index, statement: 'cashflow' }]; }`;
  const modules = [decoy, honest];
  let n = 0;
  const result = await repairStatements({ filings: [filing(4, body)], writeModule: async () => ({ module_source: modules[n++], rationale: "try" }) });
  assert.match(result.attempts[0].errors.join(" "), /reconcil/i);
  assert.equal(result.status, "repaired");
  assert.equal(result.attempts.length, 2);
  assert.ok(result.reconciliation.every(r => r.status === "passed"));
});

test("AC-10: a model-call failure propagates instead of being counted as a repair attempt", async () => {
  let calls = 0;
  await assert.rejects(repairStatements({ filings: [german(5)], writeModule: async () => { calls++; throw new Error("budget exhausted"); } }),
    /budget exhausted/);
  assert.equal(calls, 1);
});
