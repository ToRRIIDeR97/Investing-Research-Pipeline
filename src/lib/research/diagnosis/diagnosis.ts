/**
 * Historical diagnosis engine for Research OS v3.
 */

import type { HistoricalObservation } from "@/lib/research/history/contracts";
import { detectInflections } from "@/lib/research/history/diagnostics";
import type { DiagnosisRecord, HistoricalDiagnosisArtifact } from "./contracts";
import { TrendDirection, StructuralCyclicalTemporary } from "./contracts";

export type BuildDiagnosisInput = {
  asset_id: string;
  run_id?: string;
  observations: HistoricalObservation[];
  materialMetricKeys: string[];
  processNodeMapping?: Record<string, string | undefined>;
  supportingClaims: Record<string, string[]>;
  supportingObservations?: Record<string, string[]>;
  contradictingClaims?: Record<string, string[]>;
  endFiscalYear: number;
  endFiscalQuarter: number;
};

export function buildHistoricalDiagnosis(input: BuildDiagnosisInput): HistoricalDiagnosisArtifact {
  const byMetric = groupByMetric(input.observations);
  const diagnoses: DiagnosisRecord[] = [];
  const unexplained: HistoricalDiagnosisArtifact["unexplained_inflections"] = [];

  for (const metricKey of input.materialMetricKeys) {
    const series = byMetric.get(metricKey) ?? [];
    const sorted = series
      .filter((o) => o.value_numeric != null && o.fiscal_year != null)
      .sort((a, b) => (a.fiscal_year! * 10 + (a.fiscal_quarter ?? 0)) - (b.fiscal_year! * 10 + (b.fiscal_quarter ?? 0)));
    if (sorted.length === 0) continue;

    const values = sorted.map((o) => o.value_numeric!);
    const current = values[values.length - 1];
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const sortedVals = [...values].sort((a, b) => a - b);
    const median = sortedVals.length % 2 === 0
      ? (sortedVals[sortedVals.length / 2 - 1] + sortedVals[sortedVals.length / 2]) / 2
      : sortedVals[Math.floor(sortedVals.length / 2)];
    const min = Math.min(...values);
    const max = Math.max(...values);
    const stdDev = Math.sqrt(values.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / values.length);

    const sufficientHistory = values.length >= 4;
    const trend = sufficientHistory ? classifyTrend(values) : "insufficient_history";
    const stability = sufficientHistory ? (stdDev === 0 ? 1 : 1 / (1 + stdDev / Math.abs(mean))) : 0;

    const inflections = sufficientHistory ? detectInflections(sorted, 1.5) : [];
    const primaryInflection = inflections[0];
    const levelShift = detectLevelShift(values);
    const hasChangePoint = primaryInflection != null || levelShift;
    const causalNode = hasChangePoint
      ? (input.processNodeMapping?.[metricKey] ?? undefined)
      : undefined;

    const classification = classifyChange(
      values,
      primaryInflection,
      causalNode,
      input.supportingClaims[metricKey]?.length ?? 0
    );

    if (hasChangePoint && !causalNode) {
      unexplained.push({
        metric_key: metricKey,
        period: primaryInflection
          ? `${primaryInflection.fiscal_year}Q${primaryInflection.fiscal_quarter ?? ""}`
          : `${sorted[0].fiscal_year}Q${sorted[0].fiscal_quarter ?? ""}-${sorted[sorted.length - 1].fiscal_year}Q${sorted[sorted.length - 1].fiscal_quarter ?? ""}`,
        z_score: primaryInflection?.z_score ?? 0,
      });
    }

    diagnoses.push({
      metric_key: metricKey,
      current_level: current,
      historical_mean: mean,
      historical_median: median,
      historical_min: min,
      historical_max: max,
      historical_std_dev: stdDev,
      observation_count: values.length,
      trend,
      stability: Math.max(0, Math.min(1, stability)),
      inflection_period: primaryInflection
        ? `${primaryInflection.fiscal_year}Q${primaryInflection.fiscal_quarter ?? ""}`
        : undefined,
      inflection_z_score: primaryInflection?.z_score,
      causal_process_node: causalNode,
      management_control: "unassigned",
      structural_cyclical_temporary_or_accounting: classification,
      moat_implication: undefined,
      forecast_implication: sufficientHistory
        ? `Current trend for ${metricKey} is ${trend}; expect ${classification === "structural" ? "durability" : "reversion risk"}.`
        : `Only ${values.length} observation(s) for ${metricKey}; no trend or stability forecast is supported.`,
      supporting_claim_ids: input.supportingClaims[metricKey] ?? [],
      supporting_observation_ids: input.supportingObservations?.[metricKey] ?? [],
      ...(!input.supportingClaims[metricKey]?.length ? { source_gap: "No metric-specific evidence claim supports a causal explanation. Linked observations support the statistics only." } : {}),
      contradicting_claim_ids: input.contradictingClaims?.[metricKey] ?? [],
      confidence: sufficientHistory ? (primaryInflection ? (causalNode ? 0.75 : 0.45) : 0.7) : 0.2,
    });
  }

  return {
    artifact_type: "historical_diagnosis",
    asset_id: input.asset_id,
    run_id: input.run_id,
    diagnoses,
    unexplained_inflections: unexplained,
  };
}

function classifyTrend(values: number[]): TrendDirection {
  if (values.length < 2) return "stable";
  const firstHalf = values.slice(0, Math.floor(values.length / 2));
  const secondHalf = values.slice(Math.floor(values.length / 2));
  const firstMean = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
  const secondMean = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
  if (Math.abs(secondMean - firstMean) / (Math.abs(firstMean) || 1) < 0.05) return "stable";
  return secondMean > firstMean ? "increasing" : "decreasing";
}

function classifyChange(
  values: number[],
  inflection: { z_score: number } | undefined,
  causalNode: string | undefined,
  supportingClaimCount: number
): StructuralCyclicalTemporary {
  const levelShift = detectLevelShift(values);
  if (!levelShift && !inflection) return "unexplained";
  if (!causalNode) return "unexplained";
  if (supportingClaimCount < 1) return "temporary";
  return "structural";
}

function detectLevelShift(values: number[], thresholdSigma = 1.5): boolean {
  if (values.length < 6) return false;
  const mid = Math.floor(values.length / 2);
  const first = values.slice(0, mid);
  const second = values.slice(mid);
  const firstMean = first.reduce((a, b) => a + b, 0) / first.length;
  const secondMean = second.reduce((a, b) => a + b, 0) / second.length;
  const stdDev = Math.sqrt(values.reduce((acc, v) => acc + Math.pow(v - mean(values), 2), 0) / values.length);
  if (stdDev === 0) return false;
  return Math.abs(secondMean - firstMean) / stdDev >= thresholdSigma;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function groupByMetric(observations: HistoricalObservation[]): Map<string, HistoricalObservation[]> {
  const map = new Map<string, HistoricalObservation[]>();
  for (const o of observations) {
    const list = map.get(o.metric_key) ?? [];
    list.push(o);
    map.set(o.metric_key, list);
  }
  return map;
}

export function diagnoseMetric(
  metricKey: string,
  observations: HistoricalObservation[],
  processNode?: string,
  supportingClaimIds: string[] = [],
  contradictingClaimIds: string[] = []
): DiagnosisRecord {
  const diagnosis = buildHistoricalDiagnosis({
    asset_id: "",
    observations,
    materialMetricKeys: [metricKey],
    processNodeMapping: processNode ? { [metricKey]: processNode } : undefined,
    supportingClaims: { [metricKey]: supportingClaimIds },
    contradictingClaims: { [metricKey]: contradictingClaimIds },
    endFiscalYear: 2024,
    endFiscalQuarter: 4,
  });
  return diagnosis.diagnoses[0];
}
