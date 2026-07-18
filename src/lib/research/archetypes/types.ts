/**
 * Archetype type definitions for Research OS v3 composable research profiles.
 */

export type SourceRoleRequirement = {
  role: string;
  required: boolean;
  rationale: string;
  blockedArtifacts: string[];
};

export type HistoricalMetricRequirement = {
  metric_family: string;
  required: boolean;
  minimum_quarters: number;
  rationale: string;
};

export type ArtifactRequirement = {
  artifact_type: string;
  required: boolean;
  scope: "default" | string;
  rationale: string;
};

export type ProcessNodeRequirement = {
  node_key: string;
  required: boolean;
  rationale: string;
};

export type ValuationMethodRule = {
  method: string;
  allowed: boolean;
  required: boolean;
  rationale: string;
};

export type ScenarioDriverRequirement = {
  driver_key: string;
  required: boolean;
  rationale: string;
};

export type MonitoringKPI = {
  kpi_key: string;
  frequency: string;
  rationale: string;
};

export type OptionalBranch = {
  branch_key: string;
  allowed: boolean;
  default_enabled: boolean;
  rationale: string;
};

export type BusinessArchetype = {
  key: string;
  name: string;
  description: string;
  source_roles: SourceRoleRequirement[];
  historical_metrics: HistoricalMetricRequirement[];
  required_artifacts: ArtifactRequirement[];
  required_process_nodes: ProcessNodeRequirement[];
  valuation_methods: ValuationMethodRule[];
  required_scenario_drivers: ScenarioDriverRequirement[];
  monitoring_kpis: MonitoringKPI[];
  optional_branches: OptionalBranch[];
  overlays: string[];
  conflicts_with: string[];
};

export type ArchetypeOverlay = {
  key: string;
  name: string;
  applies_to: string[];
  source_roles: SourceRoleRequirement[];
  historical_metrics: HistoricalMetricRequirement[];
  required_artifacts: ArtifactRequirement[];
  required_process_nodes: ProcessNodeRequirement[];
  valuation_methods: ValuationMethodRule[];
  required_scenario_drivers: ScenarioDriverRequirement[];
  monitoring_kpis: MonitoringKPI[];
  optional_branches: OptionalBranch[];
};

export type ComposedProfile = {
  profile_id: string;
  asset_id: string;
  archetypes: string[];
  overlays: string[];
  source_roles: SourceRoleRequirement[];
  historical_metrics: HistoricalMetricRequirement[];
  required_artifacts: ArtifactRequirement[];
  required_process_nodes: ProcessNodeRequirement[];
  valuation_methods: ValuationMethodRule[];
  required_scenario_drivers: ScenarioDriverRequirement[];
  monitoring_kpis: MonitoringKPI[];
  optional_branches: OptionalBranch[];
  backtest_required: boolean;
  composition_conflicts: string[];
  composition_warnings: string[];
};

export type ArchetypeCompositionError = {
  code: "conflict" | "missing_base" | "unknown_archetype";
  message: string;
  detail?: Record<string, unknown>;
};
