/**
 * Composable archetype composition logic for Research OS v3.
 */

import { businessArchetypes, archetypeOverlays, getArchetype, getOverlay, isDefaultValuationRule } from "./registry";
import type {
  ComposedProfile,
  ArchetypeCompositionError,
  SourceRoleRequirement,
  HistoricalMetricRequirement,
  ArtifactRequirement,
  ProcessNodeRequirement,
  ValuationMethodRule,
  ScenarioDriverRequirement,
  MonitoringKPI,
  OptionalBranch,
} from "./types";

function dedupeByKey<T extends { [key: string]: any }>(items: T[], key: keyof T): T[] {
  const seen = new Map<string, T>();
  for (const item of items) {
    const k = String(item[key]);
    if (!seen.has(k)) {
      seen.set(k, item);
      continue;
    }
    // For booleans like required, prefer true
    const existing = seen.get(k)!;
    const merged = { ...existing } as T;
    if ("required" in item && "required" in existing) {
      (merged as any).required = (existing as any).required || (item as any).required;
    }
    if ("allowed" in item && "allowed" in existing) {
      (merged as any).allowed = (existing as any).allowed && (item as any).allowed;
    }
    if ("default_enabled" in item && "default_enabled" in existing) {
      (merged as any).default_enabled = (existing as any).default_enabled || (item as any).default_enabled;
    }
    if ("minimum_quarters" in item && "minimum_quarters" in existing) {
      (merged as any).minimum_quarters = Math.max((existing as any).minimum_quarters, (item as any).minimum_quarters);
    }
    seen.set(k, merged);
  }
  return Array.from(seen.values());
}

export function composeProfile(
  profileId: string,
  assetId: string,
  archetypeKeys: string[],
  overlayKeys: string[] = [],
  timingHypothesis?: { accepted: boolean }
): { profile: ComposedProfile; errors: ArchetypeCompositionError[] } {
  const errors: ArchetypeCompositionError[] = [];

  if (!archetypeKeys.includes("operating_company_core") && !archetypeKeys.includes("etf_fund") && !archetypeKeys.includes("bank")) {
    errors.push({
      code: "missing_base",
      message: "A profile must include 'operating_company_core' or 'etf_fund' as a base archetype.",
    });
  }

  const resolvedArchetypes = archetypeKeys.map((k) => {
    const a = getArchetype(k);
    if (!a) {
      errors.push({ code: "unknown_archetype", message: `Unknown archetype: ${k}`, detail: { key: k } });
    }
    return a;
  }).filter((a): a is NonNullable<typeof a> => a !== undefined);

  const resolvedOverlays = overlayKeys.map((k) => {
    const o = getOverlay(k);
    if (!o) {
      errors.push({ code: "unknown_archetype", message: `Unknown overlay: ${k}`, detail: { key: k } });
    }
    return o;
  }).filter((o): o is NonNullable<typeof o> => o !== undefined);

  // Conflict detection
  const allKeys = new Set(archetypeKeys);
  for (const a of resolvedArchetypes) {
    for (const conflict of a.conflicts_with) {
      if (allKeys.has(conflict)) {
        errors.push({
          code: "conflict",
          message: `Archetype '${a.key}' conflicts with '${conflict}'.`,
          detail: { a: a.key, b: conflict },
        });
      }
    }
  }

  // Valuation method conflicts. A specific archetype's explicit rule for a method (one that differs from the shared
  // defaults, e.g. holding_company requiring sotp or etf_fund forbidding dcf) overrides operating_company_core's rule,
  // so core + holding_company composes instead of conflicting on sotp. Two specific archetypes can still conflict.
  const explicitMethods = new Set(resolvedArchetypes.filter((a) => a.key !== "operating_company_core")
    .flatMap((a) => a.valuation_methods).filter((r) => !isDefaultValuationRule(r)).map((r) => r.method));
  const methodRules: ValuationMethodRule[] = [
    ...resolvedArchetypes.flatMap((a) => a.key === "operating_company_core"
      ? a.valuation_methods.filter((r) => !explicitMethods.has(r.method)) : a.valuation_methods),
    ...resolvedOverlays.flatMap((o) => o.valuation_methods),
  ];
  const methodsByKey = new Map<string, ValuationMethodRule[]>();
  for (const m of methodRules) {
    if (!methodsByKey.has(m.method)) methodsByKey.set(m.method, []);
    methodsByKey.get(m.method)!.push(m);
  }
  for (const [method, rules] of methodsByKey) {
    const allowed = rules.every((r) => r.allowed);
    const required = rules.some((r) => r.required);
    if (allowed && required) {
      // fine
    } else if (!allowed && required && !(method === "nav" && archetypeKeys.includes("bank"))) {
      errors.push({
        code: "conflict",
        message: `Valuation method '${method}' is both required and forbidden by the selected archetypes/overlays.`,
        detail: { method },
      });
    }
  }

  const source_roles = dedupeByKey<SourceRoleRequirement>(
    [...resolvedArchetypes.flatMap((a) => a.source_roles), ...resolvedOverlays.flatMap((o) => o.source_roles)],
    "role"
  );
  const historical_metrics = dedupeByKey<HistoricalMetricRequirement>(
    [...resolvedArchetypes.flatMap((a) => a.historical_metrics), ...resolvedOverlays.flatMap((o) => o.historical_metrics)],
    "metric_family"
  );
  const required_artifacts = dedupeByKey<ArtifactRequirement>(
    [...resolvedArchetypes.flatMap((a) => a.required_artifacts), ...resolvedOverlays.flatMap((o) => o.required_artifacts)],
    "artifact_type"
  );
  const required_process_nodes = dedupeByKey<ProcessNodeRequirement>(
    [...resolvedArchetypes.flatMap((a) => a.required_process_nodes), ...resolvedOverlays.flatMap((o) => o.required_process_nodes)],
    "node_key"
  );
  const valuation_methods = dedupeByKey<ValuationMethodRule>(methodRules, "method")
    .map((rule) => rule.method === "nav" && archetypeKeys.includes("bank")
      ? { ...rule, allowed: true, required: true, rationale: "Bank valuation uses tangible book value" }
      : rule);
  const required_scenario_drivers = dedupeByKey<ScenarioDriverRequirement>(
    [...resolvedArchetypes.flatMap((a) => a.required_scenario_drivers), ...resolvedOverlays.flatMap((o) => o.required_scenario_drivers)],
    "driver_key"
  );
  const monitoring_kpis = dedupeByKey<MonitoringKPI>(
    [...resolvedArchetypes.flatMap((a) => a.monitoring_kpis), ...resolvedOverlays.flatMap((o) => o.monitoring_kpis)],
    "kpi_key"
  );
  const optional_branches = dedupeByKey<OptionalBranch>(
    [...resolvedArchetypes.flatMap((a) => a.optional_branches), ...resolvedOverlays.flatMap((o) => o.optional_branches)],
    "branch_key"
  );

  const backtestBranch = optional_branches.find((b) => b.branch_key === "backtest");
  const backtest_required = !!(backtestBranch?.allowed && (timingHypothesis?.accepted ?? false));
  if (backtest_required && !timingHypothesis?.accepted) {
    errors.push({
      code: "conflict",
      message: "Backtest branch is enabled but no explicit timing hypothesis is accepted.",
    });
  }

  const warnings: string[] = [];
  if (!archetypeKeys.includes("operating_company_core") && archetypeKeys.includes("marketplace")) {
    warnings.push("Marketplace archetype selected without operating_company_core; some base artifacts may be missing.");
  }

  const profile: ComposedProfile = {
    profile_id: profileId,
    asset_id: assetId,
    archetypes: archetypeKeys,
    overlays: overlayKeys,
    source_roles,
    historical_metrics,
    required_artifacts,
    required_process_nodes,
    valuation_methods,
    required_scenario_drivers,
    monitoring_kpis,
    optional_branches,
    backtest_required,
    composition_conflicts: errors.filter((e) => e.code === "conflict").map((e) => e.message),
    composition_warnings: warnings,
  };

  return { profile, errors };
}

export function validateCompositionForRun(
  archetypeKeys: string[],
  overlayKeys: string[] = []
): ArchetypeCompositionError[] {
  const { errors } = composeProfile("validate", "validate", archetypeKeys, overlayKeys);
  return errors;
}

export function listAvailableArchetypes(): { key: string; name: string }[] {
  return businessArchetypes.map((a) => ({ key: a.key, name: a.name }));
}

export function listAvailableOverlays(): { key: string; name: string }[] {
  return archetypeOverlays.map((o) => ({ key: o.key, name: o.name }));
}
