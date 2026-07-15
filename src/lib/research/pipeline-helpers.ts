export type SecFactRow = Record<string, unknown>;

function dateValue(value: unknown) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? time : 0;
}

function durationDays(row: SecFactRow) {
  if (!row.start || !row.end) return null;
  return Math.round((dateValue(row.end) - dateValue(row.start)) / 86_400_000);
}

/** Selects an instant fact, or a genuine annual duration fact when requested. */
export function selectLatestFact(rows: SecFactRow[], preferAnnual = false) {
  const annualForms = new Set(["10-K", "20-F", "40-F"]);
  const candidates = rows.filter((row) => {
    if (!Number.isFinite(Number(row.val))) return false;
    if (!preferAnnual) return !row.start || durationDays(row) === null;
    const duration = durationDays(row);
    return annualForms.has(String(row.form)) && row.fp === "FY" && duration !== null && duration >= 300 && duration <= 400;
  });
  return candidates.sort((a, b) =>
    dateValue(b.end) - dateValue(a.end) ||
    dateValue(b.filed) - dateValue(a.filed) ||
    String(a.conceptName || "").localeCompare(String(b.conceptName || ""))
  )[0] || null;
}

export interface RetrievalChunk {
  id: string;
  sourceId: string;
  parseId: string;
  chunkIndex: number;
  charStart: number;
  charEnd: number;
  sectionTitle?: string;
  text: string;
  sourceTitle: string;
  sourceType: string;
}

/** Deterministic bounded retrieval: source openings plus the most relevant middle/closing chunks. */
export function selectRelevantChunks(chunks: RetrievalChunk[], terms: string[], maxChunks = 18, excerptChars = 5000) {
  const normalizedTerms = [...new Set(terms.flatMap((term) => term.toLowerCase().split(/[^a-z0-9]+/)).filter((term) => term.length >= 3))];
  const bySource = new Map<string, RetrievalChunk[]>();
  for (const chunk of chunks) bySource.set(chunk.sourceId, [...(bySource.get(chunk.sourceId) || []), chunk]);
  const openings: RetrievalChunk[] = [];
  for (const sourceChunks of bySource.values()) {
    sourceChunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
    if (sourceChunks[0]) openings.push(sourceChunks[0]);
  }
  const score = (chunk: RetrievalChunk) => {
    const haystack = `${chunk.sectionTitle || ""} ${chunk.text}`.toLowerCase();
    const matches = normalizedTerms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
    const sourceLength = bySource.get(chunk.sourceId)?.length || 1;
    const middleBonus = chunk.chunkIndex > 0 && chunk.chunkIndex < sourceLength - 1 ? 0.5 : 0;
    return matches + middleBonus;
  };
  // Openings provide document identity and filing context, but must never
  // consume the whole packet when a run has many sources. Reserve at most a
  // quarter of the packet for them and spend the rest on substantive chunks.
  const openingBudget = Math.min(openings.length, Math.max(1, Math.floor(maxChunks / 4)));
  const selected = openings
    .sort((a, b) => score(b) - score(a) || a.sourceId.localeCompare(b.sourceId))
    .slice(0, openingBudget);
  const selectedIds = new Set(selected.map((chunk) => chunk.id));
  selected.push(...chunks
    .filter((chunk) => !selectedIds.has(chunk.id))
    .sort((a, b) => score(b) - score(a) || a.sourceId.localeCompare(b.sourceId) || a.chunkIndex - b.chunkIndex)
    .slice(0, Math.max(0, maxChunks - selected.length)));
  return selected
    .map((chunk) => ({ ...chunk, text: chunk.text.slice(0, excerptChars) }))
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.chunkIndex - b.chunkIndex);
}

function observationIdentity(obs: Record<string, unknown>) {
  return [obs.metric_key || obs.metric || obs.label, obs.period_start || "", obs.period_end || obs.as_of_date || "", obs.unit || "", obs.currency || ""].join("|").toLowerCase();
}

export function canonicalMetricPlan(existing: Array<{ id: string; value_numeric: unknown; review_status?: unknown }>, canonicalValue: string | null) {
  const matching = existing.find((row) => String(row.value_numeric ?? "") === String(canonicalValue ?? ""));
  return {
    promoteId: matching?.id || null,
    demoteIds: existing.filter((row) => row.id !== matching?.id && row.review_status === "accepted").map((row) => row.id),
    insert: !matching,
  };
}

export function normalizeSourceGap(gap: Record<string, unknown>, owner: string) {
  const rawDescription = gap.description || gap.detail || gap.reason || gap.gap;
  const description = String(rawDescription || "Unresolved research source gap.").trim();
  const explicit = String(gap.gap_key || gap.key || gap.gap || "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 96);
  const severityValue = String(gap.severity || "medium").toLowerCase();
  return {
    gapKey: explicit || `${owner.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}_${description.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 64)}`,
    description,
    severity: ["critical", "high", "medium", "low"].includes(severityValue) ? severityValue : "medium",
  };
}

export const MODULE_TERMS: Record<string, string[]> = {
  provisions: ["provision", "credit loss", "allowance", "expected credit loss"],
  credit_losses: ["credit loss", "allowance", "charge-off", "delinquen"],
  loan_book: ["loan", "credit portfolio", "receivable", "delinquen", "non-performing"],
  customer_funds: ["customer fund", "customer balance", "wallet balance", "funds payable"],
  funding_liabilities: ["funding liabil", "borrowings", "funding mix", "deposits"],
  net_interest_margin_after_losses: ["net interest margin", "interest margin after loss", "nimal"],
  gmv: ["gmv", "gross merchandise volume"],
  tpv: ["tpv", "total payment volume"],
  working_capital: ["working capital", "receivable", "payable", "inventory"],
  net_debt: ["net debt", "total debt", "borrowings", "cash and equivalents"],
  total_debt: ["debt", "borrowings", "notes payable"],
  fcf: ["fcf", "free cash flow", "operating cash flow", "capital expenditure", "capex"],
  capex: ["capital expenditure", "capex", "property and equipment"],
};

export function evidenceRelevantToModule(moduleKey: string, claim: Record<string, unknown>) {
  const canonical = moduleKey === "nimal" ? "net_interest_margin_after_losses" : moduleKey;
  const terms = MODULE_TERMS[canonical] || canonical.split("_").filter((term) => term.length >= 3);
  const haystack = `${claim.claim_text || ""} ${claim.claim_type || ""} ${claim.claim_category || ""}`.toLowerCase();
  return terms.some((term) => haystack.includes(term));
}

function getPeriodDays(start: unknown, end: unknown): number {
  const t1 = Date.parse(String(start || ""));
  const t2 = Date.parse(String(end || ""));
  if (isNaN(t1) || isNaN(t2)) return 0;
  return Math.round((t2 - t1) / 86_400_000);
}

function checkQuartersCoverage(annual: Record<string, unknown>, quarters: Record<string, unknown>[]): boolean {
  if (quarters.length !== 4) return false;
  // Sort quarters by start date
  quarters.sort((a, b) => Date.parse(String(a.period_start)) - Date.parse(String(b.period_start)));
  
  const toleranceMs = 7 * 24 * 60 * 60 * 1000; // 7 days tolerance
  
  const annualStart = Date.parse(String(annual.period_start));
  const annualEnd = Date.parse(String(annual.period_end));
  const qStart = Date.parse(String(quarters[0].period_start));
  const qEnd = Date.parse(String(quarters[3].period_end));
  
  if (Math.abs(qStart - annualStart) > toleranceMs || Math.abs(qEnd - annualEnd) > toleranceMs) {
    return false;
  }
  
  for (let i = 0; i < 3; i++) {
    const end = Date.parse(String(quarters[i].period_end));
    const nextStart = Date.parse(String(quarters[i+1].period_start));
    if (Math.abs(nextStart - end) > toleranceMs) {
      return false;
    }
  }
  return true;
}

export function reconcileMetricObservations(deterministic: Record<string, unknown>[], agent: Record<string, unknown>[]) {
  const accepted = new Map<string, Record<string, unknown>>();
  const conflicts: Record<string, unknown>[] = [];
  for (const [origin, observations] of [["deterministic", deterministic], ["agent", agent]] as const) {
    for (const observation of observations) {
      const identity = observationIdentity(observation);
      const existing = accepted.get(identity);
      if (!existing) {
        accepted.set(identity, { ...observation, reconciliation_origin: origin });
        continue;
      }
      const current = Number(existing.value_numeric ?? existing.value);
      const alternative = Number(observation.value_numeric ?? observation.value);
      if (Number.isFinite(current) && Number.isFinite(alternative) && Math.abs(current - alternative) > Math.max(1e-9, Math.abs(current) * 1e-6)) {
        conflicts.push({ identity, accepted_value: current, rejected_value: alternative, accepted_origin: existing.reconciliation_origin, rejected_origin: origin });
      }
    }
  }

  // Quarterly and annual reconciliation checks
  const list = [...accepted.values()];
  const annuals = list.filter(obs => {
    const days = getPeriodDays(obs.period_start, obs.period_end);
    return days >= 300 && days <= 380;
  });
  
  const quarters = list.filter(obs => {
    const days = getPeriodDays(obs.period_start, obs.period_end);
    return days >= 75 && days <= 105;
  });

  for (const annual of annuals) {
    const key = String(annual.metric_key || annual.metric || "");
    const currency = String(annual.currency || "");
    
    const matchingQuarters = quarters.filter(q => 
      String(q.metric_key || q.metric || "") === key &&
      String(q.currency || "") === currency &&
      Date.parse(String(q.period_start)) >= Date.parse(String(annual.period_start)) &&
      Date.parse(String(q.period_end)) <= Date.parse(String(annual.period_end))
    );
    
    if (checkQuartersCoverage(annual, matchingQuarters)) {
      const annualValue = Number(annual.value_numeric ?? annual.value);
      const sumQuarters = matchingQuarters.reduce((sum, q) => sum + Number(q.value_numeric ?? q.value), 0);
      const diff = Math.abs(annualValue - sumQuarters);
      const maxAllowedDiff = Math.max(1.0, Math.abs(annualValue) * 0.01);
      
      if (diff > maxAllowedDiff) {
        const identity = observationIdentity(annual);
        accepted.delete(identity);
        conflicts.push({
          identity,
          accepted_value: sumQuarters,
          rejected_value: annualValue,
          accepted_origin: "quarterly_sum",
          rejected_origin: String(annual.reconciliation_origin || "annual_fact"),
          reason: `Annual value ${annualValue} is materially inconsistent with the sum of quarters ${sumQuarters} (diff ${diff} > max allowed ${maxAllowedDiff})`
        });
      }
    }
  }

  return { accepted: [...accepted.values()], conflicts };
}

export function moduleCompletion(section: Record<string, unknown> | undefined) {
  if (!section) return { status: "needs_more_work", reason: "No module-specific analysis was returned." };
  const summary = String(section.summary || section.body || section.content || "").trim();
  const evidence = [
    ...(Array.isArray(section.evidence) ? section.evidence : []),
    ...(Array.isArray(section.evidence_claim_ids) ? section.evidence_claim_ids : []),
  ].filter(Boolean);
  if (summary.length < 80 || evidence.length === 0) {
    return { status: "needs_more_work", reason: "Module requires a substantive summary and module-specific evidence provenance." };
  }
  return { status: "completed", reason: null };
}
