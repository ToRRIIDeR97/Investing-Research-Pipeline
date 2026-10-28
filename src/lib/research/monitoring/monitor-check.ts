/**
 * monitor-check: a free, deterministic check of each asset against its latest completed run. It looks for
 * periodic filings (10-Q/10-K, a foreign issuer's 20-F/40-F, their amendments, and 6-K results releases) on EDGAR newer than the run's source cutoff, captures their statements with the filing
 * parser, scores the run's monitoring dashboard on them, and stores whether a refresh is due. It makes no
 * model call and never queues or starts a run: a person decides whether to refresh.
 *
 * Filings are untrusted: only the deterministic parser reads them, only EDGAR hosts are fetched, and nothing
 * from a filing's text reaches the stored reasons except validated dates, forms and numbers.
 */
import type { Sql } from "../run-context";
import { fetchCapped, isPrivateHostname } from "@/lib/net";
import { isResultsCover, loadSubmissionFilings, resolveSecCik, secArchiveUrl, storedSecFiling } from "../sources/corpus";
import { extractFilingStatements, statementObservations, type FilingSource, type FilingTable } from "../history/filing-statements";
import { refreshDecision, scoreDashboard, type MonitorFiling, type MonitorItemResult } from "./monitor-score";

/** The only hosts monitor-check fetches. */
export const EDGAR_HOSTS = ["data.sec.gov", "www.sec.gov"];
const SEC_USER_AGENT = "ResearchOS/0.1 research-pipeline@example.com";
/** Periodic reports and their amendments. A 6-K counts only when its cover names a results release. */
const FORMS = new Set(["10-Q", "10-K", "20-F", "40-F", "10-Q/A", "10-K/A", "20-F/A", "40-F/A"]);
const RESULTS_FORM = "6-K";
/** Newest 6-K covers read per check: a frequent filer files several a month, and results come once a quarter. */
const MAX_SIX_K_COVERS = 12;
/** Newest filings captured per check; older new filings are listed but not parsed. */
const MAX_CAPTURED = 4;
const MAX_FILING_BYTES = 40_000_000;
const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;
const DOCUMENT = /^[A-Za-z0-9][\w.-]{0,180}\.html?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Refuses any URL that is not HTTPS on an EDGAR host, then fetches it with the SEC User-Agent and no redirects. */
export function edgarFetch(fetchImpl: typeof fetch = (url, init) => fetchCapped(String(url), init, { maxBytes: MAX_FILING_BYTES })): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.protocol !== "https:" || !EDGAR_HOSTS.includes(url.hostname) || url.username || url.password || isPrivateHostname(url.hostname)) {
      throw new Error(`monitor-check refuses ${url.protocol}//${url.hostname}: only ${EDGAR_HOSTS.join(", ")} over HTTPS`);
    }
    return fetchImpl(url.toString(), { ...init, redirect: "error", headers: { ...(init?.headers as Record<string, string> | undefined), "User-Agent": SEC_USER_AGENT } });
  };
}

export interface MonitorTarget {
  asset_id: string; slug: string; symbol: string | null; run_id: string; source_cutoff_at: string; cik: string | null;
}

/** Each asset's latest completed pipeline-v3 run (optionally only the given slugs). */
export async function monitorTargets(sql: Sql, slugs: string[] = []): Promise<MonitorTarget[]> {
  const rows = await sql`SELECT DISTINCT ON (a.id) a.id AS asset_id, a.slug, rr.id AS run_id, rr.source_cutoff_at, rr.created_at,
      (SELECT l.symbol FROM instruments i JOIN listings l ON l.instrument_id = i.id WHERE i.asset_id = a.id AND l.active_to IS NULL
        ORDER BY l.is_primary DESC NULLS LAST, l.created_at ASC NULLS LAST LIMIT 1) AS symbol,
      (SELECT substring(sd.url from 'sec\\.gov/Archives/edgar/data/([0-9]+)/') FROM research_run_sources rrs
        JOIN source_documents sd ON sd.id = rrs.source_document_id
        WHERE rrs.research_run_id = rr.id AND sd.url ~ 'sec\\.gov/Archives/edgar/data/[0-9]+/' LIMIT 1) AS cik
    FROM assets a JOIN research_runs rr ON rr.asset_id = a.id
    WHERE rr.status = 'completed' AND rr.pipeline_version = 3
      ${slugs.length ? sql`AND a.slug = ANY(${slugs}::text[])` : sql``}
    ORDER BY a.id, rr.completed_at DESC NULLS LAST, rr.created_at DESC`;
  return rows.map(r => ({ asset_id: String(r.asset_id), slug: String(r.slug), symbol: r.symbol ? String(r.symbol) : null, run_id: String(r.run_id),
    source_cutoff_at: new Date(r.source_cutoff_at ?? r.created_at).toISOString(), cik: r.cik ? String(r.cik).padStart(10, "0") : null }));
}

async function latestContent(sql: Sql, runId: string, type: string): Promise<Record<string, any> | null> {
  const [row] = await sql`SELECT content_json FROM research_artifacts WHERE research_run_id = ${runId} AND artifact_type = ${type}
    AND status IN ('validated', 'accepted') ORDER BY artifact_version DESC, created_at DESC LIMIT 1`;
  return row?.content_json ?? null;
}

export interface MonitorResult {
  asset_id: string; slug: string; run_id: string | null; status: "refresh_due" | "current" | "skipped" | "failed";
  refresh_due: boolean; reasons: string[]; filings: MonitorFiling[]; kpis: MonitorItemResult[];
}

/** Check one asset. Never writes to the run; the caller stores the result. */
export async function checkAsset(sql: Sql, target: MonitorTarget, options: { fetch?: typeof fetch; now?: Date } = {}): Promise<MonitorResult> {
  const fetchEdgar = edgarFetch(options.fetch);
  const now = options.now ?? new Date();
  const base = { asset_id: target.asset_id, slug: target.slug, run_id: target.run_id };
  const cik = target.cik ?? (target.symbol ? await resolveSecCik(target.symbol, fetchEdgar).catch(() => null) : null);
  if (!cik) return { ...base, status: "skipped", refresh_due: false, reasons: ["No SEC CIK for this asset, so EDGAR cannot be checked."], filings: [], kpis: [] };

  const cutoff = target.source_cutoff_at.slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  const response = await fetchEdgar(`https://data.sec.gov/submissions/CIK${cik}.json`);
  if (!response.ok) throw new Error(`SEC submissions for CIK ${cik} failed: ${response.status}`);
  const submissions = await response.json();
  const rows = await loadSubmissionFilings(submissions, cutoff, today, fetchEdgar);
  const fresh = rows.filter(f => (FORMS.has(f.form) || f.form === RESULTS_FORM) && DATE.test(String(f.filingDate ?? "")) && String(f.filingDate) > cutoff && String(f.filingDate) <= today
    && ACCESSION.test(String(f.accessionNumber ?? "")) && DOCUMENT.test(String(f.primaryDocument ?? "")));

  const filings: MonitorFiling[] = [];
  const tables: FilingTable[] = [];
  const filingHtml = async (url: string) => {
    const stored = await storedSecFiling(sql, url);
    if (stored !== null) return stored;
    const download = await fetchEdgar(url);
    return download.ok ? download.text() : null;
  };
  let parsed = 0, covers = 0;
  for (const f of fresh) {
    const url = secArchiveUrl(cik, f.accessionNumber!, f.primaryDocument!);
    const reportDate = DATE.test(String(f.reportDate ?? "")) ? String(f.reportDate) : null;
    const filing: MonitorFiling = { form: f.form, filing_date: String(f.filingDate), report_date: reportDate, accession: f.accessionNumber!, url, captured: false };
    // A 6-K is listed only when its cover names a results release; its statements sit in an exhibit, so none are parsed.
    if (f.form === RESULTS_FORM) {
      if (covers++ >= MAX_SIX_K_COVERS) continue;
      const cover = await filingHtml(url);
      if (cover !== null && isResultsCover(cover)) filings.push(filing);
      continue;
    }
    filings.push(filing);
    if (parsed++ >= MAX_CAPTURED) continue;
    const html = await filingHtml(url);
    if (html === null) continue;
    const source: FilingSource = { id: `monitor:${f.accessionNumber}`, url, published_at: String(f.filingDate), period_end: reportDate ?? "", metadata_json: { form: f.form, accessionNumber: f.accessionNumber } };
    const captured = extractFilingStatements(html, source);
    filing.captured = captured.length > 0;
    tables.push(...captured);
  }

  const dashboard = await latestContent(sql, target.run_id, "monitoring_dashboard");
  const statements = await latestContent(sql, target.run_id, "financial_statement_set");
  const schedule = await latestContent(sql, target.run_id, "refresh_schedule");
  // Prior tables let year-to-date cash flows become discrete quarters; readings come only from the new periods.
  const priorTables: FilingTable[] = Array.isArray(statements?.tables) ? statements!.tables : [];
  const newPeriods = new Set(tables.map(t => `${t.fiscal_year}-${t.fiscal_quarter}`));
  const observations = tables.length ? statementObservations([...priorTables, ...tables]) as Record<string, any>[] : [];
  const isNew = (o: Record<string, any>) => newPeriods.has(`${o.fiscal_year}-${o.periodicity === "annual" ? 4 : o.fiscal_quarter}`);
  const kpis = scoreDashboard(dashboard?.items ?? [], observations.filter(isNew), observations.filter(o => !isNew(o)));
  const decision = refreshDecision({ filings, kpis, nextRefreshAt: typeof schedule?.next_refresh_at === "string" ? schedule.next_refresh_at : null, now });
  return { ...base, status: decision.refresh_due ? "refresh_due" : "current", refresh_due: decision.refresh_due, reasons: decision.reasons, filings, kpis };
}

export async function saveMonitorResult(sql: Sql, result: MonitorResult, checkedAt = new Date()) {
  const [row] = await sql`INSERT INTO asset_monitor_checks (asset_id, research_run_id, status, refresh_due, reasons_json, filings_json, kpis_json, checked_at)
    VALUES (${result.asset_id}, ${result.run_id}, ${result.status}, ${result.refresh_due}, ${JSON.stringify(result.reasons)}::text::jsonb,
      ${JSON.stringify(result.filings)}::text::jsonb, ${JSON.stringify(result.kpis)}::text::jsonb, ${checkedAt.toISOString()}) RETURNING id`;
  return String(row.id);
}

/** Check every target and store each result; one asset's failure is stored as failed and does not stop the rest. */
export async function runMonitorCheck(sql: Sql, options: { slugs?: string[]; fetch?: typeof fetch; now?: Date } = {}) {
  const results: MonitorResult[] = [];
  for (const target of await monitorTargets(sql, options.slugs)) {
    let result: MonitorResult;
    try { result = await checkAsset(sql, target, options); }
    catch (error) {
      result = { asset_id: target.asset_id, slug: target.slug, run_id: target.run_id, status: "failed", refresh_due: false,
        reasons: [`Check failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`], filings: [], kpis: [] };
    }
    await saveMonitorResult(sql, result, options.now);
    results.push(result);
  }
  return results;
}

/** The latest stored check for an asset, for the asset page. */
export async function latestMonitorCheck(sql: Sql, assetId: string) {
  const [row] = await sql`SELECT m.id, m.research_run_id, m.status, m.refresh_due, m.reasons_json, m.filings_json, m.kpis_json, m.checked_at,
      EXISTS (SELECT 1 FROM research_runs r JOIN research_runs checked ON checked.id = m.research_run_id
        WHERE r.asset_id = m.asset_id AND r.created_at > checked.created_at) AS newer_run
    FROM asset_monitor_checks m WHERE m.asset_id = ${assetId} ORDER BY m.checked_at DESC, m.created_at DESC LIMIT 1`;
  return row ? { id: String(row.id), run_id: row.research_run_id ? String(row.research_run_id) : null, status: String(row.status), refresh_due: Boolean(row.refresh_due),
    reasons: row.reasons_json as string[], filings: row.filings_json as MonitorFiling[], kpis: row.kpis_json as MonitorItemResult[],
    checked_at: new Date(row.checked_at).toISOString(), newer_run: Boolean(row.newer_run) } : null;
}
