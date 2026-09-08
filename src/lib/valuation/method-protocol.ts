import { z } from "zod";

/**
 * The valuation protocol deliberately accepts data and formula graphs, not
 * generated source code. Models may design a method, while Research OS owns
 * execution, provenance checks, and the shape of the resulting artifacts.
 */
export const VALUATION_METHOD_PROTOCOL_VERSION = "1.0";

export const VALUATION_OPERATIONS = [
  "add",
  "subtract",
  "multiply",
  "divide",
  "sum",
  "average",
  "min",
  "max",
  "negate",
  "abs",
  "power",
  "discount",
  "terminal_growth",
  "clamp",
] as const;

const keySchema = z.string().min(1).max(96).regex(/^[a-z][a-z0-9_]*$/);
const finiteNumber = z.number().finite();
const valueReferenceSchema = z.union([finiteNumber, keySchema]);

const methodInputSchema = z.object({
  key: keySchema,
  label: z.string().min(1).max(160),
  source: z.enum(["metric", "assumption", "constant"]),
  metric_key: keySchema.optional(),
  value: finiteNumber.optional(),
  unit: z.string().min(1).max(48),
  currency: z.string().min(1).max(12).optional(),
  evidence_claim_ids: z.array(z.string().uuid()).max(32).default([]),
  rationale: z.string().max(1_000).optional(),
}).strict();

const formulaNodeSchema = z.object({
  key: keySchema,
  label: z.string().min(1).max(160),
  operation: z.enum(VALUATION_OPERATIONS),
  args: z.array(valueReferenceSchema).min(1).max(32),
  unit: z.string().min(1).max(48),
  currency: z.string().min(1).max(12).optional(),
}).strict();

const scenarioSchema = z.object({
  scenario_name: z.string().min(1).max(160),
  scenario_type: z.enum(["bull", "base", "bear"]),
  probability: z.number().finite().min(0).max(1),
  overrides: z.record(keySchema, finiteNumber).default({}),
  confidence: z.number().finite().min(0).max(1),
  rationale: z.string().min(1).max(2_000),
}).strict();

const tableSchema = z.object({
  table_key: keySchema,
  title: z.string().min(1).max(160),
  columns: z.array(z.string().min(1).max(80)).min(1).max(24),
  rows: z.array(z.object({
    label: z.string().min(1).max(160),
    cells: z.record(z.string().min(1).max(80), valueReferenceSchema),
  }).strict()).min(1).max(100),
}).strict();

export const valuationMethodSpecSchema = z.object({
  protocol_version: z.literal(VALUATION_METHOD_PROTOCOL_VERSION),
  method_key: keySchema,
  method_name: z.string().min(1).max(160),
  method_version: z.string().min(1).max(40),
  method_family: keySchema,
  origin: z.enum(["registered", "composed", "proposed"]),
  rationale: z.string().min(20).max(4_000),
  replaces_method_keys: z.array(keySchema).max(16).default([]),
  inputs: z.array(methodInputSchema).min(1).max(128),
  formulas: z.array(formulaNodeSchema).min(1).max(128),
  outputs: z.object({
    enterprise_value: keySchema.optional(),
    equity_value: keySchema.optional(),
    per_share_value: keySchema,
  }).strict(),
  scenarios: z.array(scenarioSchema).length(3),
  tables: z.array(tableSchema).min(1).max(12),
  limitations: z.array(z.string().min(1).max(1_000)).max(32).default([]),
}).strict();

export type ValuationMethodSpec = z.infer<typeof valuationMethodSpecSchema>;

export interface ValuationMetricInput {
  id: string;
  metricKey: string;
  value: number;
  unit?: string;
  currency?: string;
  evidenceClaimId?: string | null;
}

export interface ExecutedValuationScenario {
  scenarioName: string;
  scenarioType: "bull" | "base" | "bear";
  probability: number;
  confidence: number;
  valueAnchor: number;
  values: Record<string, number>;
  overrides: Record<string, number>;
  rationale: string;
}

export interface ValuationExecutionResult {
  valid: boolean;
  methodState: "blocked" | "validated";
  spec: ValuationMethodSpec | null;
  errors: string[];
  warnings: string[];
  values: Record<string, number>;
  outputs: Record<string, number>;
  scenarios: ExecutedValuationScenario[];
  tables: Array<{
    tableKey: string;
    title: string;
    columns: string[];
    rows: Array<{ label: string; cells: Record<string, number> }>;
  }>;
  inputManifest: Array<{
    key: string;
    source: "metric" | "assumption" | "constant";
    value: number;
    metricKey?: string;
    metricObservationId?: string;
    evidenceClaimIds: string[];
    unit: string;
    currency?: string;
  }>;
}

const OPERATION_ARITY: Record<(typeof VALUATION_OPERATIONS)[number], { min: number; max: number }> = {
  add: { min: 2, max: 32 },
  subtract: { min: 2, max: 2 },
  multiply: { min: 2, max: 32 },
  divide: { min: 2, max: 2 },
  sum: { min: 1, max: 32 },
  average: { min: 1, max: 32 },
  min: { min: 1, max: 32 },
  max: { min: 1, max: 32 },
  negate: { min: 1, max: 1 },
  abs: { min: 1, max: 1 },
  power: { min: 2, max: 2 },
  discount: { min: 3, max: 3 },
  terminal_growth: { min: 3, max: 3 },
  clamp: { min: 3, max: 3 },
};

function calculate(operation: ValuationMethodSpec["formulas"][number]["operation"], args: number[]) {
  switch (operation) {
    case "add":
    case "sum": return args.reduce((total, value) => total + value, 0);
    case "subtract": return args[0] - args[1];
    case "multiply": return args.reduce((total, value) => total * value, 1);
    case "divide": {
      if (args[1] === 0) throw new Error("division by zero");
      return args[0] / args[1];
    }
    case "average": return args.reduce((total, value) => total + value, 0) / args.length;
    case "min": return Math.min(...args);
    case "max": return Math.max(...args);
    case "negate": return -args[0];
    case "abs": return Math.abs(args[0]);
    case "power": return Math.pow(args[0], args[1]);
    case "discount": {
      if (args[1] <= -1) throw new Error("discount rate must be greater than -1");
      return args[0] / Math.pow(1 + args[1], args[2]);
    }
    case "terminal_growth": {
      if (args[2] <= args[1]) throw new Error("discount rate must exceed terminal growth");
      return (args[0] * (1 + args[1])) / (args[2] - args[1]);
    }
    case "clamp": return Math.min(Math.max(args[0], args[1]), args[2]);
  }
}

function resolveRef(ref: string | number, values: Record<string, number>) {
  if (typeof ref === "number") return ref;
  if (!(ref in values)) throw new Error(`undefined reference "${ref}"`);
  return values[ref];
}

function evaluateGraph(spec: ValuationMethodSpec, initialValues: Record<string, number>) {
  const values = { ...initialValues };
  for (const node of spec.formulas) {
    const arity = OPERATION_ARITY[node.operation];
    if (node.args.length < arity.min || node.args.length > arity.max) {
      throw new Error(`${node.key}: ${node.operation} expects ${arity.min === arity.max ? arity.min : `${arity.min}-${arity.max}`} arguments`);
    }
    const args = node.args.map((arg) => resolveRef(arg, values));
    const result = calculate(node.operation, args);
    if (!Number.isFinite(result) || Math.abs(result) > 1e30) {
      throw new Error(`${node.key}: formula produced a non-finite or unbounded value`);
    }
    values[node.key] = result;
  }
  return values;
}

function emptyResult(errors: string[]): ValuationExecutionResult {
  return {
    valid: false,
    methodState: "blocked",
    spec: null,
    errors,
    warnings: [],
    values: {},
    outputs: {},
    scenarios: [],
    tables: [],
    inputManifest: [],
  };
}

/** Validate and independently execute an AI-designed valuation method. */
export function executeValuationMethod(
  candidate: unknown,
  metricInputs: ValuationMetricInput[]
): ValuationExecutionResult {
  const parsed = valuationMethodSpecSchema.safeParse(candidate);
  if (!parsed.success) {
    return emptyResult(parsed.error.issues.map((issue) => `${issue.path.join(".") || "method"}: ${issue.message}`));
  }

  const spec = parsed.data;
  const errors: string[] = [];
  const warnings: string[] = [];
  const values: Record<string, number> = {};
  const inputManifest: ValuationExecutionResult["inputManifest"] = [];
  const knownKeys = new Set<string>();
  const units = new Map<string, string>();
  const currencies = new Map<string, string>();
  const metrics = new Map(metricInputs.map((input) => [input.metricKey, input]));

  for (const input of spec.inputs) {
    if (knownKeys.has(input.key)) {
      errors.push(`Duplicate input or formula key "${input.key}".`);
      continue;
    }
    knownKeys.add(input.key);
    units.set(input.key, input.unit);
    if (input.currency) currencies.set(input.key, input.currency);
    const metricKey = input.metric_key || (metrics.has(input.key) ? input.key : undefined);
    const metric = input.source === "metric" && metricKey ? metrics.get(metricKey) : undefined;
    const value = input.source === "metric" ? metric?.value : input.value;
    if (input.source === "metric" && !metricKey) errors.push(`${input.key}: metric inputs require metric_key.`);
    if (input.source === "metric" && !metric) errors.push(`${input.key}: accepted metric "${metricKey || "unknown"}" is unavailable.`);
    if (metric?.currency && input.currency && metric.currency !== input.currency) {
      errors.push(`${input.key}: declared currency ${input.currency} conflicts with metric currency ${metric.currency}.`);
    }
    if (input.source !== "metric" && input.value === undefined) errors.push(`${input.key}: ${input.source} inputs require an explicit numeric value.`);
    if (value === undefined || !Number.isFinite(value)) continue;
    values[input.key] = value;
    const evidenceClaimIds = [...new Set([
      ...input.evidence_claim_ids,
      ...(metric?.evidenceClaimId ? [metric.evidenceClaimId] : []),
    ])];
    inputManifest.push({
      key: input.key,
      source: input.source,
      value,
      metricKey,
      metricObservationId: metric?.id,
      evidenceClaimIds,
      unit: input.unit,
      currency: input.currency,
    });
    if (input.source === "metric" && !evidenceClaimIds.length) {
      warnings.push(`${input.key}: metric observation has no direct evidence claim; observation provenance is retained.`);
    }
  }

  for (const formula of spec.formulas) {
    if (knownKeys.has(formula.key)) errors.push(`Duplicate input or formula key "${formula.key}".`);
    for (const ref of formula.args) {
      if (typeof ref === "string" && !knownKeys.has(ref)) errors.push(`${formula.key}: reference "${ref}" is undefined or forward-referenced.`);
    }
    const referencedKeys = formula.args.filter((arg): arg is string => typeof arg === "string");
    const compatibleOperation = ["add", "subtract", "sum", "average", "min", "max", "clamp"].includes(formula.operation);
    if (compatibleOperation) {
      const referencedUnits = [...new Set(referencedKeys.map((key) => units.get(key)).filter(Boolean))];
      if (referencedUnits.length > 1) errors.push(`${formula.key}: ${formula.operation} operands use incompatible units (${referencedUnits.join(", ")}).`);
      if (referencedUnits.length === 1 && referencedUnits[0] !== formula.unit) {
        errors.push(`${formula.key}: result unit ${formula.unit} does not match operand unit ${referencedUnits[0]}.`);
      }
      const referencedCurrencies = [...new Set(referencedKeys.map((key) => currencies.get(key)).filter(Boolean))];
      if (referencedCurrencies.length > 1) errors.push(`${formula.key}: operands mix currencies (${referencedCurrencies.join(", ")}).`);
      if (formula.currency && referencedCurrencies.length === 1 && formula.currency !== referencedCurrencies[0]) {
        errors.push(`${formula.key}: result currency ${formula.currency} does not match operand currency ${referencedCurrencies[0]}.`);
      }
    }
    units.set(formula.key, formula.unit);
    if (formula.currency) currencies.set(formula.key, formula.currency);
    knownKeys.add(formula.key);
  }
  for (const [name, ref] of Object.entries(spec.outputs)) {
    if (ref && !knownKeys.has(ref)) errors.push(`Output ${name} references undefined key "${ref}".`);
  }
  const perShareUnit = units.get(spec.outputs.per_share_value) || "";
  if (!/(?:per[_ ]share|\/share)/i.test(perShareUnit)) {
    errors.push(`Output per_share_value must reference a value with a per-share unit, got "${perShareUnit || "unknown"}."`);
  }
  for (const scenario of spec.scenarios) {
    for (const key of Object.keys(scenario.overrides)) {
      if (!spec.inputs.some((input) => input.key === key)) errors.push(`${scenario.scenario_type}: override "${key}" is not a declared input.`);
    }
  }
  for (const table of spec.tables) {
    const columns = new Set(table.columns);
    for (const row of table.rows) {
      const cellColumns = Object.keys(row.cells);
      for (const column of cellColumns) {
        if (!columns.has(column)) errors.push(`${table.table_key}/${row.label}: cell column "${column}" is not declared.`);
      }
      for (const column of columns) {
        if (!(column in row.cells)) errors.push(`${table.table_key}/${row.label}: declared column "${column}" has no cell.`);
      }
    }
  }
  const scenarioTypes = new Set(spec.scenarios.map((scenario) => scenario.scenario_type));
  for (const type of ["bull", "base", "bear"] as const) {
    if (!scenarioTypes.has(type)) errors.push(`Missing ${type} scenario.`);
  }
  const probabilityTotal = spec.scenarios.reduce((total, scenario) => total + scenario.probability, 0);
  if (Math.abs(probabilityTotal - 1) > 0.001) errors.push(`Scenario probabilities total ${probabilityTotal}, expected 1.`);

  if (errors.length) return { ...emptyResult(errors), spec, warnings, inputManifest };

  let baseValues: Record<string, number>;
  try {
    baseValues = evaluateGraph(spec, values);
  } catch (error) {
    return { ...emptyResult([error instanceof Error ? error.message : String(error)]), spec, warnings, inputManifest };
  }

  const outputs: Record<string, number> = {};
  for (const [name, ref] of Object.entries(spec.outputs)) {
    if (ref) outputs[name] = baseValues[ref];
  }

  const scenarios: ExecutedValuationScenario[] = [];
  for (const scenario of spec.scenarios) {
    try {
      const scenarioValues = evaluateGraph(spec, { ...values, ...scenario.overrides });
      scenarios.push({
        scenarioName: scenario.scenario_name,
        scenarioType: scenario.scenario_type,
        probability: scenario.probability,
        confidence: scenario.confidence,
        valueAnchor: scenarioValues[spec.outputs.per_share_value],
        values: scenarioValues,
        overrides: scenario.overrides,
        rationale: scenario.rationale,
      });
    } catch (error) {
      errors.push(`${scenario.scenario_type}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const byType = new Map(scenarios.map((scenario) => [scenario.scenarioType, scenario]));
  const bull = byType.get("bull")?.valueAnchor;
  const base = byType.get("base")?.valueAnchor;
  const bear = byType.get("bear")?.valueAnchor;
  if ([bull, base, bear].some((value) => value === undefined || !Number.isFinite(value))) {
    errors.push("Every scenario must produce a finite per-share value.");
  } else if (!(Number(bear) <= Number(base) && Number(base) <= Number(bull))) {
    errors.push("Scenario ordering must satisfy bear <= base <= bull per-share value.");
  }

  const tables: ValuationExecutionResult["tables"] = [];
  for (const table of spec.tables) {
    const rows: ValuationExecutionResult["tables"][number]["rows"] = [];
    for (const row of table.rows) {
      const cells: Record<string, number> = {};
      try {
        for (const [column, ref] of Object.entries(row.cells)) cells[column] = resolveRef(ref, baseValues);
      } catch (error) {
        errors.push(`${table.table_key}/${row.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
      rows.push({ label: row.label, cells });
    }
    tables.push({ tableKey: table.table_key, title: table.title, columns: table.columns, rows });
  }

  return {
    valid: errors.length === 0,
    methodState: errors.length ? "blocked" : "validated",
    spec,
    errors,
    warnings,
    values: baseValues,
    outputs,
    scenarios,
    tables,
    inputManifest,
  };
}

export function methodSatisfiesRequiredModel(spec: ValuationMethodSpec, requiredModelKey: string) {
  return spec.method_key === requiredModelKey || spec.replaces_method_keys.includes(requiredModelKey);
}

export function methodCandidateClaimsRequiredModel(candidate: unknown, requiredModelKey: string) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const record = candidate as Record<string, unknown>;
  return record.method_key === requiredModelKey || (
    Array.isArray(record.replaces_method_keys) && record.replaces_method_keys.includes(requiredModelKey)
  );
}

export function validateValuationMethodSet(
  candidates: unknown[],
  requiredModelKeys: string[],
  metricInputs: ValuationMetricInput[]
) {
  const errors: string[] = [];
  const executions = new Map<string, ValuationExecutionResult>();
  for (const requiredModelKey of requiredModelKeys) {
    const matching = candidates.find((candidate) => methodCandidateClaimsRequiredModel(candidate, requiredModelKey));
    if (!matching) {
      errors.push(`${requiredModelKey}: no conforming method proposal names or replaces this required model.`);
      continue;
    }
    const execution = executeValuationMethod(matching, metricInputs);
    executions.set(requiredModelKey, execution);
    errors.push(...execution.errors.map((error) => `${requiredModelKey}: ${error}`));
  }
  return { valid: errors.length === 0, errors, executions };
}
