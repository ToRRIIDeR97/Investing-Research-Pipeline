/**
 * Decision synthesis finalize step. The model makes the judgment calls; code drops citations outside
 * the accepted packet, moves flagged items, and sets the fields the valuation stage already decided.
 */

import type { AgentOutputFormat } from "@/lib/agent-harness/types";
import { DECISION_SYNTHESIS_CONTRACT } from "../stage-contracts";
import { dropInvalidCitationIds } from "../sources/artifact-evidence";
import { WITHHELD_VALUATION_LINKAGE } from "./validation";

export interface DecisionFinalizeInputs {
  acceptedClaimIds: string[];
  valuation: { status: "complete" | "withheld"; terminalYear?: number; withheldReason?: string };
  marketPrice: number | null;
  terminalReturns: { bear: number; base: number; bull: number } | null; // null: no returns can be computed
  probabilities: { probability_bear: number; probability_base: number; probability_bull: number } | null;
  dilutionCovered: boolean; // the terminal projection covers the reported diluted shares
}

export interface DecisionAdjustments {
  dropped_citation_ids: string[];
  moved_catalysts: { catalyst_name: string; reason: "business_driver_only" }[];
  moved_risks: { risk_name: string; reason: "source_gap_only" | "no_supporting_evidence" }[];
}

export const DECISION_GAP_OWNER = "system:decision-synthesis";
export type DecisionGap = { gap_key: string; description: string; severity: "medium"; owner: typeof DECISION_GAP_OWNER };

const JUDGMENT_KEYS = ["no_rerating_return", "weak_stock_outcome", "permanent_loss_limit"] as const;

const isRecord = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

/** A copy of the model's answer without the fields only finalize writes (adjustments, moved drivers). */
export function stripCodeOwnedFields(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const copy = structuredClone(raw);
  if (isRecord(copy.decision_record)) delete copy.decision_record.adjustments;
  if (isRecord(copy.monitoring_dashboard)) delete copy.monitoring_dashboard.drivers;
  return copy;
}

export function finalizeDecisionOutput(raw: unknown, inputs: DecisionFinalizeInputs): {
  output: Record<string, any>;
  adjustments: DecisionAdjustments;
  gaps: DecisionGap[];
  errors: { path: string; message: string }[];
} {
  const output: Record<string, any> = isRecord(raw) ? structuredClone(raw) : {};
  const errors: { path: string; message: string }[] = [];
  const gaps: DecisionGap[] = [];
  const movedCatalysts: DecisionAdjustments["moved_catalysts"] = [];
  const movedRisks: DecisionAdjustments["moved_risks"] = [];

  // 1. Citations outside the accepted packet are dropped and recorded, never added to prose.
  const dropped = dropInvalidCitationIds(output, inputs.acceptedClaimIds);

  // 2. Driver catalysts become monitoring drivers; source-gap or uncited risks become open gaps.
  const catalysts = output.catalyst_register?.catalysts;
  if (Array.isArray(catalysts)) {
    const drivers = catalysts.filter((c) => c?.is_business_driver_only === true);
    output.catalyst_register.catalysts = catalysts.filter((c) => !drivers.includes(c));
    if (drivers.length && isRecord(output.monitoring_dashboard)) {
      output.monitoring_dashboard.drivers = [...list(output.monitoring_dashboard.drivers), ...drivers.map((c) => ({
        name: c.catalyst_name, mechanism: c.event_mechanism, model_input_affected: c.model_input_affected, evidence: c.evidence,
      }))];
    }
    movedCatalysts.push(...drivers.map((c) => ({ catalyst_name: String(c.catalyst_name), reason: "business_driver_only" as const })));
  }
  const risks = output.risk_register?.risks;
  if (Array.isArray(risks)) {
    const keys = new Set<string>();
    output.risk_register.risks = risks.filter((r) => {
      const reason = r?.is_source_gap_only === true ? "source_gap_only"
        : Array.isArray(r?.supporting_claim_ids) && !r.supporting_claim_ids.length ? "no_supporting_evidence" : null;
      if (!reason) return true;
      const name = String(r.risk_name || "Unnamed risk");
      const base = `decision_risk_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 72)}`;
      let gapKey = base;
      for (let n = 2; keys.has(gapKey); n++) gapKey = `${base}_${n}`;
      keys.add(gapKey);
      movedRisks.push({ risk_name: name, reason });
      gaps.push({
        gap_key: gapKey, severity: "medium", owner: DECISION_GAP_OWNER,
        description: reason === "source_gap_only"
          ? `Source gap flagged by decision synthesis: ${name}. ${r.causal_mechanism || ""}`.trim()
          : `Risk without accepted supporting evidence: ${name}. ${r.causal_mechanism || ""}`.trim(),
      });
      return false;
    });
  }

  // 3. An empty register is the only failure this step adds.
  if (Array.isArray(output.risk_register?.risks) && !output.risk_register.risks.length) {
    errors.push({ path: "risk_register", message: "No operating risk remains after source gaps and uncited risks were moved to evidence gaps." });
  }
  if (Array.isArray(output.catalyst_register?.catalysts) && !output.catalyst_register.catalysts.length) {
    errors.push({ path: "catalyst_register", message: "No dated catalyst remains after business drivers were moved to monitoring." });
  }

  // 4. Thesis fields follow the valuation stage.
  const withheld = inputs.valuation.status === "withheld";
  const year = inputs.valuation.terminalYear;
  const returns = !withheld && inputs.terminalReturns && inputs.dilutionCovered ? inputs.terminalReturns : null;
  const p = inputs.probabilities;
  const weighted = returns && p
    ? Number(p.probability_bear) * returns.bear + Number(p.probability_base) * returns.base + Number(p.probability_bull) * returns.bull
    : NaN;
  const weightedReturn = Number.isFinite(weighted) ? Number(weighted.toFixed(6)) : null;
  const thesis = output.investment_thesis;
  if (isRecord(thesis)) {
    thesis.valuation_accepted_first = !withheld;
    if (withheld) {
      const text = String(thesis.expected_return_linkage || "").trim();
      const linkage = (text.startsWith(WITHHELD_VALUATION_LINKAGE) ? text.slice(WITHHELD_VALUATION_LINKAGE.length) : text).trim();
      thesis.expected_return_linkage = `${WITHHELD_VALUATION_LINKAGE} ${linkage || inputs.valuation.withheldReason || ""}`.trim();
    } else if (returns && Number.isFinite(year)) {
      thesis.horizon = `Through fiscal ${year}`;
      thesis.expected_return_linkage =
        `Fiscal ${year} diluted-share price targets imply bear ${pct(returns.bear)}, base ${pct(returns.base)}, ` +
        `and bull ${pct(returns.bull)} total returns` +
        (inputs.marketPrice != null ? ` from $${inputs.marketPrice.toFixed(2)}` : "") +
        (p && weightedReturn != null ? `; operating scenario weights ${[p.probability_bear, p.probability_base, p.probability_bull]
          .map((w) => (Number(w) * 100).toFixed(0)).join("/")} produce ${pct(weightedReturn)}` : "") +
        ". Future share issuance beyond the reported diluted count remains a source gap.";
    }
  }
  if (withheld && isRecord(output.decision_record)) output.decision_record.decision = "pending";

  // 5. Returns come from the valuation stage; the model keeps only its judgment fields.
  const matrix = output.expected_return_matrix;
  if (isRecord(matrix)) {
    matrix.status = withheld ? "withheld" : returns ? "estimated" : "unavailable";
    matrix.bear_return = returns?.bear ?? null;
    matrix.base_return = returns?.base ?? null;
    matrix.bull_return = returns?.bull ?? null;
    matrix.probability_weighted_return = returns ? weightedReturn : null;
    if (withheld) for (const key of JUDGMENT_KEYS) matrix[key] = null;
    matrix.dilution_omitted = false;
  }

  // 6. Adjustments accumulate, so finalizing a finalized output changes nothing.
  const prior = isRecord(output.decision_record?.adjustments) ? output.decision_record.adjustments : {};
  const adjustments: DecisionAdjustments = {
    dropped_citation_ids: [...new Set([...list(prior.dropped_citation_ids), ...dropped])],
    moved_catalysts: [...list(prior.moved_catalysts), ...movedCatalysts],
    moved_risks: [...list(prior.moved_risks), ...movedRisks],
  };
  if (isRecord(output.decision_record)) output.decision_record.adjustments = adjustments;
  return { output, adjustments, gaps, errors };
}

/** Model-facing format: the answer is judged after finalizing a copy, so code-owned fields never fail it. */
export function decisionOutputFormat(inputs: DecisionFinalizeInputs): AgentOutputFormat {
  return {
    requiredKeys: DECISION_SYNTHESIS_CONTRACT.requiredKeys,
    schema: DECISION_SYNTHESIS_CONTRACT.schema,
    validate(value) {
      const { output, errors } = finalizeDecisionOutput(stripCodeOwnedFields(value), inputs);
      return [...(DECISION_SYNTHESIS_CONTRACT.validate?.(output) || []), ...errors];
    },
  };
}
