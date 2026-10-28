import postgres from "postgres";

// ============================================================
// Valuation Signal Generator — §8, §27.10
// Asset-profile-aware valuation signal generation.
// ============================================================

type Sql = ReturnType<typeof postgres> | postgres.TransactionSql;
type Band = { signal: string; cheapness: number | null };

const INCONCLUSIVE: Band = { signal: "inconclusive", cheapness: null };

/** P/E band. A loss (P/E <= 0) or a missing value says nothing about cheapness (#135). */
export function peBand(pe: number): Band {
  if (!Number.isFinite(pe) || pe <= 0) return INCONCLUSIVE;
  if (pe < 15) return { signal: "cheap", cheapness: 75 };
  if (pe < 20) return { signal: "neutral", cheapness: 50 };
  if (pe < 30) return { signal: "expensive", cheapness: 25 };
  return { signal: "very_expensive", cheapness: 10 };
}

/**
 * FCF-yield band. Yields are stored as fractions (0.05 = 5%, as in reporting/facts); a value above 1
 * is taken as a percent, since a free-cash-flow yield over 100% is not plausible (#135).
 */
export function fcfYieldBand(value: number): Band {
  if (!Number.isFinite(value)) return INCONCLUSIVE;
  const fraction = Math.abs(value) > 1 ? value / 100 : value;
  if (fraction > 0.08) return { signal: "very_cheap", cheapness: 90 };
  if (fraction > 0.05) return { signal: "cheap", cheapness: 70 };
  if (fraction > 0.03) return { signal: "neutral", cheapness: 50 };
  return { signal: "expensive", cheapness: 25 };
}

interface SignalInput {
  assetId: string;
  runId: string;
  profileId: string;
  profileKey: string;
}

/**
 * Generate valuation signals based on the asset's research profile.
 * Reads metric observations and creates valuation signals.
 */
export async function generateValuationSignals(
  input: SignalInput
): Promise<{ signalCount: number; signals: Record<string, unknown>[] }> {
  const client = postgres(process.env.DATABASE_URL!);

  try {
    // One transaction, and a rerun replaces this generator's earlier signals (#135).
    return await client.begin(async (sql) => {
      // Get valuation methods applicable to this profile
      const methods = await sql`
        SELECT * FROM valuation_methods
        WHERE ${input.profileKey} = ANY(applicable_profile_keys)
      `;

      // Get metric observations for this asset/run
      const observations = await sql`
        SELECT mo.*, md.metric_key, md.display_name, md.metric_category
        FROM metric_observations mo
        JOIN metric_definitions md ON mo.metric_definition_id = md.id
        WHERE mo.asset_id = ${input.assetId}
          AND mo.research_run_id = ${input.runId}
          AND mo.review_status != 'rejected'
        ORDER BY md.metric_key, mo.as_of_date DESC NULLS LAST, mo.period_end DESC NULLS LAST,
          mo.available_at DESC NULLS LAST, mo.id
      `;

      const signals: Record<string, unknown>[] = [];

      // Generate signals based on profile type
      switch (input.profileKey) {
        case "operating_company":
          signals.push(
            ...(await generateOperatingCompanySignals(sql, input, observations, methods))
          );
          break;
        case "bitcoin":
          signals.push(
            ...(await generateBitcoinSignals(sql, input, observations, methods))
          );
          break;
        case "financials":
          signals.push(
            ...(await generateFinancialsSignals(sql, input, observations, methods))
          );
          break;
        default:
          signals.push(
            ...(await generateGenericSignals(sql, input, observations, methods))
          );
      }

      const keys = [...new Set(signals.map((row) => String(row.signal_key)))];
      const ids = signals.map((row) => String(row.id));
      if (keys.length) await sql`
        DELETE FROM valuation_signals
        WHERE research_run_id = ${input.runId} AND signal_key = ANY(${keys}::text[]) AND id <> ALL(${ids}::uuid[])
      `;

      return { signalCount: signals.length, signals };
    }) as { signalCount: number; signals: Record<string, unknown>[] };
  } finally {
    await client.end();
  }
}

async function generateOperatingCompanySignals(
  sql: Sql,
  input: SignalInput,
  observations: any[],
  methods: any[]
): Promise<Record<string, unknown>[]> {
  const signals: Record<string, unknown>[] = [];

  // PE multiple signal
  const peObs = observations.find((o) => o.metric_key === "pe_ratio");
  if (peObs) {
    const peMethod = methods.find((m) => m.method_key === "pe_multiple");
    const { signal, cheapness } = peBand(parseFloat(peObs.value_numeric));

    const inserted = await sql`
      INSERT INTO valuation_signals (
        asset_id, research_run_id, profile_id,
        valuation_method_id, metric_definition_id,
        signal_key, signal_name, lens_family,
        current_value, signal, cheapness_score, confidence,
        source_document_id, evidence_claim_id
      ) VALUES (
        ${input.assetId}, ${input.runId}, ${input.profileId},
        ${peMethod?.id || null}, ${peObs.metric_definition_id},
        'pe_multiple', 'P/E Multiple', 'multiple',
        ${peObs.value_numeric}, ${signal}, ${cheapness},
        ${peObs.confidence || 0.7},
        ${peObs.source_document_id || null}, ${peObs.evidence_claim_id || null}
      )
      RETURNING *
    `;
    signals.push(inserted[0]);
  }

  // FCF Yield signal
  const fcfYieldObs = observations.find((o) => o.metric_key === "fcf_yield");
  if (fcfYieldObs) {
    const { signal, cheapness } = fcfYieldBand(parseFloat(fcfYieldObs.value_numeric));

    const inserted = await sql`
      INSERT INTO valuation_signals (
        asset_id, research_run_id, profile_id,
        signal_key, signal_name, lens_family,
        current_value, signal, cheapness_score, confidence,
        source_document_id, evidence_claim_id
      ) VALUES (
        ${input.assetId}, ${input.runId}, ${input.profileId},
        'fcf_yield', 'Free Cash Flow Yield', 'cash_flow',
        ${fcfYieldObs.value_numeric}, ${signal}, ${cheapness},
        ${fcfYieldObs.confidence || 0.7},
        ${fcfYieldObs.source_document_id || null}, ${fcfYieldObs.evidence_claim_id || null}
      )
      RETURNING *
    `;
    signals.push(inserted[0]);
  }

  // Record DCF as attempted if we have the method
  const dcfMethod = methods.find((m) => m.method_key === "driver_based_dcf");
  if (dcfMethod) {
    // DCF requires code — record as pending
    const inserted = await sql`
      INSERT INTO valuation_signals (
        asset_id, research_run_id, profile_id,
        valuation_method_id, signal_key, signal_name, lens_family,
        signal, confidence
      ) VALUES (
        ${input.assetId}, ${input.runId}, ${input.profileId},
        ${dcfMethod.id}, 'dcf_fair_value', 'DCF Fair Value', 'dcf',
        'inconclusive', 0.5
      )
      RETURNING *
    `;
    signals.push(inserted[0]);
  }

  return signals;
}

async function generateBitcoinSignals(
  sql: Sql,
  input: SignalInput,
  observations: any[],
  methods: any[]
): Promise<Record<string, unknown>[]> {
  const signals: Record<string, unknown>[] = [];

  // MVRV signal
  const mvrvObs = observations.find((o) => o.metric_key === "mvrv_ratio");
  if (mvrvObs) {
    const mvrv = parseFloat(mvrvObs.value_numeric);
    let signal = "neutral";
    let cheapness: number | null = 50;
    if (!Number.isFinite(mvrv)) ({ signal, cheapness } = INCONCLUSIVE);
    else if (mvrv < 1.0) { signal = "very_cheap"; cheapness = 95; }
    else if (mvrv < 1.5) { signal = "cheap"; cheapness = 75; }
    else if (mvrv < 2.5) { signal = "neutral"; cheapness = 50; }
    else if (mvrv < 3.5) { signal = "expensive"; cheapness = 25; }
    else { signal = "very_expensive"; cheapness = 10; }

    const inserted = await sql`
      INSERT INTO valuation_signals (
        asset_id, research_run_id, profile_id,
        signal_key, signal_name, lens_family,
        current_value, signal, cheapness_score, confidence,
        source_document_id, evidence_claim_id
      ) VALUES (
        ${input.assetId}, ${input.runId}, ${input.profileId},
        'mvrv_zscore', 'MVRV Z-Score', 'crypto_onchain',
        ${mvrvObs.value_numeric}, ${signal}, ${cheapness},
        ${mvrvObs.confidence || 0.7},
        ${mvrvObs.source_document_id || null}, ${mvrvObs.evidence_claim_id || null}
      )
      RETURNING *
    `;
    signals.push(inserted[0]);
  }

  // Drawdown signal
  const drawdownObs = observations.find((o) => o.metric_key === "drawdown_from_high");
  if (drawdownObs) {
    const drawdown = Math.abs(parseFloat(drawdownObs.value_numeric));
    let signal = "neutral";
    let cheapness: number | null = 50;
    if (!Number.isFinite(drawdown)) ({ signal, cheapness } = INCONCLUSIVE);
    else if (drawdown > 60) { signal = "very_cheap"; cheapness = 90; }
    else if (drawdown > 40) { signal = "cheap"; cheapness = 70; }
    else if (drawdown > 20) { signal = "neutral"; cheapness = 50; }
    else if (drawdown > 10) { signal = "expensive"; cheapness = 30; }
    else { signal = "very_expensive"; cheapness = 15; }

    const inserted = await sql`
      INSERT INTO valuation_signals (
        asset_id, research_run_id, profile_id,
        signal_key, signal_name, lens_family,
        current_value, signal, cheapness_score, confidence,
        source_document_id, evidence_claim_id
      ) VALUES (
        ${input.assetId}, ${input.runId}, ${input.profileId},
        'drawdown_from_high', 'Drawdown from Cycle High', 'crypto_onchain',
        ${drawdownObs.value_numeric}, ${signal}, ${cheapness},
        ${drawdownObs.confidence || 0.8},
        ${drawdownObs.source_document_id || null}, ${drawdownObs.evidence_claim_id || null}
      )
      RETURNING *
    `;
    signals.push(inserted[0]);
  }

  // Record DCF as NOT APPLICABLE — critical for Bitcoin
  const dcfMethod = methods.find((m) => m.method_key === "driver_based_dcf");
  if (dcfMethod) {
    const inserted = await sql`
      INSERT INTO valuation_signals (
        asset_id, research_run_id, profile_id,
        valuation_method_id, signal_key, signal_name, lens_family,
        signal, current_value_text, confidence
      ) VALUES (
        ${input.assetId}, ${input.runId}, ${input.profileId},
        ${dcfMethod.id}, 'dcf_not_applicable', 'DCF Not Applicable', 'dcf',
        'not_applicable',
        'DCF is not applicable to Bitcoin. Bitcoin has no cash flows, earnings, or distributable economics to discount. Use crypto-native signals (MVRV, realized price, network metrics) instead.',
        1.0
      )
      RETURNING *
    `;
    signals.push(inserted[0]);
  }

  return signals;
}

async function generateFinancialsSignals(
  sql: Sql,
  input: SignalInput,
  observations: any[],
  methods: any[]
): Promise<Record<string, unknown>[]> {
  const signals: Record<string, unknown>[] = [];

  // P/TBV signal
  const ptbvObs = observations.find((o) => o.metric_key === "ptbv");
  if (ptbvObs) {
    const ptbv = parseFloat(ptbvObs.value_numeric);
    let signal = "neutral";
    let cheapness: number | null = 50;
    if (!Number.isFinite(ptbv) || ptbv <= 0) ({ signal, cheapness } = INCONCLUSIVE);
    else if (ptbv < 1.0) { signal = "very_cheap"; cheapness = 90; }
    else if (ptbv < 1.5) { signal = "cheap"; cheapness = 70; }
    else if (ptbv < 2.0) { signal = "neutral"; cheapness = 50; }
    else { signal = "expensive"; cheapness = 25; }

    const inserted = await sql`
      INSERT INTO valuation_signals (
        asset_id, research_run_id, profile_id,
        signal_key, signal_name, lens_family,
        current_value, signal, cheapness_score, confidence,
        source_document_id, evidence_claim_id
      ) VALUES (
        ${input.assetId}, ${input.runId}, ${input.profileId},
        'ptbv', 'Price / Tangible Book Value', 'residual_income',
        ${ptbvObs.value_numeric}, ${signal}, ${cheapness},
        ${ptbvObs.confidence || 0.7},
        ${ptbvObs.source_document_id || null}, ${ptbvObs.evidence_claim_id || null}
      )
      RETURNING *
    `;
    signals.push(inserted[0]);
  }

  // Record EV/EBITDA as NOT APPLICABLE for financials
  const evMethod = methods.find((m) => m.method_key === "ev_ebitda");
  if (evMethod) {
    const inserted = await sql`
      INSERT INTO valuation_signals (
        asset_id, research_run_id, profile_id,
        valuation_method_id, signal_key, signal_name, lens_family,
        signal, current_value_text, confidence
      ) VALUES (
        ${input.assetId}, ${input.runId}, ${input.profileId},
        ${evMethod.id}, 'ev_ebitda_not_applicable', 'EV/EBITDA Not Applicable', 'multiple',
        'not_applicable',
        'EV/EBITDA is not appropriate for banks because debt is part of their operating model, not a financing choice. Use P/TBV, ROE vs COE, and NIM-based approaches instead.',
        1.0
      )
      RETURNING *
    `;
    signals.push(inserted[0]);
  }

  return signals;
}

async function generateGenericSignals(
  sql: Sql,
  input: SignalInput,
  observations: any[],
  methods: any[]
): Promise<Record<string, unknown>[]> {
  // For other profiles, generate basic signals from available observations
  const signals: Record<string, unknown>[] = [];

  for (const obs of observations) {
    if (obs.value_numeric) {
      const inserted = await sql`
        INSERT INTO valuation_signals (
          asset_id, research_run_id, profile_id,
          signal_key, signal_name, lens_family,
          current_value, signal, confidence,
          source_document_id, evidence_claim_id
        ) VALUES (
          ${input.assetId}, ${input.runId}, ${input.profileId},
          ${obs.metric_key}, ${obs.display_name}, ${obs.metric_category},
          ${obs.value_numeric}, 'inconclusive',
          ${obs.confidence || 0.5},
          ${obs.source_document_id || null}, ${obs.evidence_claim_id || null}
        )
        RETURNING *
      `;
      signals.push(inserted[0]);
    }
  }

  return signals;
}
