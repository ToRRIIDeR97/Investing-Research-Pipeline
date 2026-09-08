import type { ResearchRunContext, StageHandler, ValidationResult } from "../run-context";
import { callResearchAgent, exactJsonPrompt, makeValidationResult } from "../run-context";
import { VALUATION_EXPLANATION_CONTRACT, VALUATION_METHOD_SPEC_CONTRACT } from "../stage-contracts";
import { createArtifactRepository } from "../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  VALUATION_METHOD_PROTOCOL_VERSION,
  VALUATION_OPERATIONS,
  executeValuationMethod,
  validateValuationMethodSet,
  type ValuationExecutionResult,
} from "@/lib/valuation/method-protocol";
import {
  buildValuationInputManifest,
  deriveAnnualPriceTargetPath,
  deriveReverseValuation,
  deriveValuationExpectedReturns,
  reconcileValuationMethods,
} from "../valuation/checkpoints";

const ARTIFACT_KEYS = [
  "valuation_input_manifest", "valuation_method_run", "valuation_scenario_set", "reverse_valuation",
  "annual_price_target_path", "expected_return_matrix", "valuation_explanation",
] as const;

function methodKey(value: unknown) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function executedMethod(requiredMethod: string, execution: ValuationExecutionResult) {
  return {
    required_model_key: requiredMethod,
    method_key: execution.spec!.method_key,
    method_name: execution.spec!.method_name,
    method_version: execution.spec!.method_version,
    method_family: execution.spec!.method_family,
    protocol_version: VALUATION_METHOD_PROTOCOL_VERSION,
    rationale: execution.spec!.rationale,
    inputs: execution.inputManifest,
    formulas: execution.spec!.formulas,
    outputs: execution.outputs,
    scenarios: execution.scenarios,
    tables: execution.tables,
    limitations: execution.spec!.limitations,
    warnings: execution.warnings,
  };
}

export const assetValuationHandler: StageHandler<Record<string, unknown>> = {
  stageKey: "asset_valuation",
  async execute(ctx: ResearchRunContext): Promise<Record<string, unknown>> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const [profile] = ctx.profileId ? await sql`
        SELECT required_valuation_lenses_json FROM research_profiles WHERE id = ${ctx.profileId} LIMIT 1
      ` : [];
      const requiredLenses = Array.isArray(profile?.required_valuation_lenses_json)
        ? profile.required_valuation_lenses_json.map(String)
        : (ctx.composedProfile?.valuation_methods.map((method: any) => String(method.method)) || ["reverse_dcf"]);
      const requiredMethods = [...new Set(requiredLenses.map(methodKey).filter(Boolean))];
      if (!requiredMethods.length) requiredMethods.push("reverse_dcf");

      const upstreamRows = await sql`
        SELECT id, artifact_type, schema_version, content_json FROM research_artifacts
        WHERE research_run_id = ${ctx.runId}
          AND artifact_type IN ('operating_model', 'operating_scenario_set', 'driver_tree')
          AND status IN ('validated', 'accepted')
        ORDER BY artifact_type, created_at DESC
      `;
      const upstreamArtifacts = upstreamRows.filter((row, index, rows) =>
        rows.findIndex((candidate) => candidate.artifact_type === row.artifact_type) === index
      ).map((row) => ({
        id: String(row.id), artifactType: String(row.artifact_type), schemaVersion: String(row.schema_version),
        content: row.content_json as Record<string, unknown>,
      }));
      const upstream = Object.fromEntries(upstreamArtifacts.map((artifact) => [artifact.artifactType, artifact.content])) as Record<string, any>;
      if (!upstream.operating_scenario_set) throw new Error("Valuation requires an accepted operating scenario set.");

      const metricRows = await sql`
        SELECT mo.id, mo.evidence_claim_id, md.metric_key, mo.period_end, mo.as_of_date,
               mo.value_numeric, mo.unit, mo.currency
        FROM metric_observations mo JOIN metric_definitions md ON md.id = mo.metric_definition_id
        WHERE mo.research_run_id = ${ctx.runId} AND mo.review_status = 'accepted'
          AND COALESCE(mo.period_end, mo.as_of_date) <= ${ctx.marketDataCutoffAt?.toISOString().slice(0, 10) || new Date().toISOString().slice(0, 10)}::date
          AND (mo.available_at IS NULL OR mo.available_at <= ${ctx.marketDataCutoffAt || new Date()})
        ORDER BY md.metric_key, COALESCE(mo.period_end, mo.as_of_date) DESC NULLS LAST
      `;
      const [marketRow] = await sql`
        SELECT dc.text FROM research_run_sources rrs
        JOIN source_documents sd ON sd.id = rrs.source_document_id
        JOIN document_parses dp ON dp.source_document_id = sd.id
        JOIN document_chunks dc ON dc.document_parse_id = dp.id
        WHERE rrs.research_run_id = ${ctx.runId} AND sd.source_type = 'market_data_snapshot'
        ORDER BY sd.retrieved_at DESC, dc.chunk_index ASC LIMIT 1
      `;
      let marketSnapshot: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(String(marketRow?.text || "{}"));
        marketSnapshot = { retrieved_at: parsed?.retrieved_at, currency: parsed?.meta?.currency, regular_market_price: parsed?.meta?.regularMarketPrice };
      } catch { /* manifest validation reports the missing price */ }

      const manifest = buildValuationInputManifest({
        runId: ctx.runId, marketSnapshot, metricRows: metricRows as any[], operatingScenarioSet: upstream.operating_scenario_set,
        requiredMethods, upstreamArtifacts,
      });
      const { executionMetrics, ...manifestArtifact } = manifest;
      const db = drizzle(sql, { schema });
      const repo = createArtifactRepository(db);
      const persistedIds: string[] = [];
      const persist = async (artifactType: string, content: Record<string, unknown>, dependencies: string[] = [], scopeSuffix = "") => {
        const artifact = await repo.upsertArtifact({
          research_run_id: ctx.runId, asset_id: ctx.assetId, profile_id: ctx.profileId || undefined,
          artifact_type: artifactType,
          scope_key: `${ctx.assetSlug}-${artifactType.replace(/_/g, "-")}${scopeSuffix}-${manifest.input_manifest_hash.slice(0, 12)}`,
          status: "validated",
          content_json: {
            ...content, run_id: ctx.runId, input_manifest_hash: manifest.input_manifest_hash,
            operating_scenario_set_id: manifest.operating_scenario_set_id,
            operating_scenario_set_version: manifest.operating_scenario_set_version,
            valuation_protocol_version: VALUATION_METHOD_PROTOCOL_VERSION,
            upstream_artifact_ids: manifest.upstream_artifact_ids,
          },
          schema_version: "4.0.0", validator_version: "2.0.0", prompt_version: "checkpointed-v1",
          created_by: "system-research-os", idempotency_key: `${ctx.runId}-${artifactType}-${manifest.input_manifest_hash}`,
        });
        persistedIds.push(String(artifact.id));
        for (const dependency of dependencies) await repo.addDependency(String(artifact.id), dependency);
        return artifact;
      };
      const manifestRecord = await persist("valuation_input_manifest", { artifact_type: "valuation_input_manifest", ...manifestArtifact }, manifest.upstream_artifact_ids);

      const methodResults = await Promise.allSettled(requiredMethods.map(async (requiredMethod) => {
        const packet = {
          valuation_method_request: { required_method: requiredMethod }, input_manifest: manifestArtifact,
          execution_metrics: executionMetrics, operating_model: upstream.operating_model || null,
          operating_scenario_set: upstream.operating_scenario_set,
          protocol: { version: VALUATION_METHOD_PROTOCOL_VERSION, allowed_operations: VALUATION_OPERATIONS, required_outputs: ["per_share_value"], required_scenarios: ["bear", "base", "bull"] },
        };
        const result = await callResearchAgent<{ method_spec: unknown }>({
          sql, ctx, stageKey: "asset_valuation", taskKey: `valuation-method:${manifest.input_manifest_hash}:${requiredMethod}`,
          taskType: "asset_valuation_method", agentName: "valuation-analyst", modelTier: "mid", packet,
          promptFactory: (value) => exactJsonPrompt({
            agentName: "valuation-analyst", requiredKeys: ["method_spec"], packet: value,
            extraRules: [
              `Design only the ${requiredMethod} method. Do not produce scenarios, price paths, reverse valuation, or prose artifacts.`,
              "Use the formula-graph protocol exactly. Every output must reference an input or formula key.",
              "Copy operating scenario probabilities exactly and include bear, base, and bull.",
              "For a financial institution include explicit return_on_equity and cost_of_equity inputs.",
            ],
          }),
          outputFormat: VALUATION_METHOD_SPEC_CONTRACT,
          validateStructured: (value) => validateValuationMethodSet([(value as any).method_spec], [requiredMethod], executionMetrics)
            .errors.map((message) => ({ path: "method_spec", message })),
        });
        const execution = executeValuationMethod(result.method_spec, executionMetrics);
        if (!execution.valid) throw new Error(`${requiredMethod}: ${execution.errors.join("; ")}`);
        const method = executedMethod(requiredMethod, execution);
        const [existingModelRun] = await sql`
          SELECT id FROM valuation_model_runs
          WHERE research_run_id = ${ctx.runId} AND model_key = ${requiredMethod}
          ORDER BY created_at ASC LIMIT 1
        `;
        const [modelRun] = existingModelRun ? await sql`
          UPDATE valuation_model_runs SET
            status = 'completed', input_manifest_json = ${JSON.stringify({ inputs: execution.inputManifest })}::jsonb,
            assumptions_json = ${JSON.stringify({ assumptions: execution.inputManifest.filter((item) => item.source === "assumption") })}::jsonb,
            outputs_json = ${JSON.stringify({ outputs: execution.outputs, scenarios: execution.scenarios, tables: execution.tables })}::jsonb,
            validation_json = ${JSON.stringify({ valid: true, warnings: execution.warnings })}::jsonb, reproducible = TRUE,
            completed_at = NOW(), updated_at = NOW(), error_message = NULL
          WHERE id = ${existingModelRun.id} RETURNING id
        ` : await sql`
          INSERT INTO valuation_model_runs (
            research_run_id, asset_id, profile_id, model_key, status, input_manifest_json,
            assumptions_json, outputs_json, validation_json, reproducible, started_at, completed_at
          ) VALUES (
            ${ctx.runId}, ${ctx.assetId}, ${ctx.profileId}, ${requiredMethod}, 'completed', ${JSON.stringify({ inputs: execution.inputManifest })}::jsonb,
            ${JSON.stringify({ assumptions: execution.inputManifest.filter((item) => item.source === "assumption") })}::jsonb,
            ${JSON.stringify({ outputs: execution.outputs, scenarios: execution.scenarios, tables: execution.tables })}::jsonb,
            ${JSON.stringify({ valid: true, warnings: execution.warnings })}::jsonb, TRUE, NOW(), NOW()
          ) RETURNING id
        `;
        const artifact = await persist("valuation_method_run", {
          artifact_type: "valuation_method_run", primary_method_key: requiredMethods[0],
          valuation_model_run_id: String(modelRun.id), methods: [method],
        }, [String(manifestRecord.id)], `-${requiredMethod}`);
        return { requiredMethod, execution, method, artifactId: String(artifact.id), modelRunId: String(modelRun.id) };
      }));
      const failures = methodResults.flatMap((result, index) => result.status === "rejected"
        ? [`${requiredMethods[index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`] : []);
      if (failures.length) throw new Error(`Valuation method checkpoints failed: ${failures.join(" | ")}`);
      const completed = methodResults.map((result) => (result as PromiseFulfilledResult<any>).value);
      const executions = new Map<string, ValuationExecutionResult>(completed.map((item) => [item.requiredMethod, item.execution]));
      const marketPrice = Number(manifest.current_market_price);
      const predictionDate = String(manifest.market_retrieved_at || new Date().toISOString()).slice(0, 10);
      const startYear = Number(predictionDate.slice(0, 4));
      const terminalYear = startYear + 4;
      const scenarioSet = reconcileValuationMethods({
        methods: executions, requiredMethods, primaryMethod: requiredMethods[0], operatingScenarioSet: upstream.operating_scenario_set, terminalYear,
      });
      const targetPath = deriveAnnualPriceTargetPath({
        scenarioSet, currentMarketPrice: marketPrice, currency: manifest.market_currency, primaryMethod: requiredMethods[0], startYear,
      });
      const profileKeys = [...(ctx.composedProfile?.archetypes || []), ...(ctx.composedProfile?.overlays || [])];
      const reverseValuation = deriveReverseValuation({
        primaryExecution: executions.get(requiredMethods[0])!, scenarioSet, currentMarketPrice: marketPrice,
        years: terminalYear - Number(predictionDate.slice(0, 4)), financialInstitution: profileKeys.some((key) => ["bank", "lender"].includes(key)),
      });
      const expectedReturns = deriveValuationExpectedReturns({ scenarioSet, priceTargetPath: targetPath, currentPrice: marketPrice, predictionDate });
      const methodDependencyIds = completed.map((item) => item.artifactId);
      const scenarioArtifact = await persist("valuation_scenario_set", scenarioSet, methodDependencyIds);
      const reverseArtifact = await persist("reverse_valuation", reverseValuation, [String(scenarioArtifact.id), ...methodDependencyIds]);
      const pathArtifact = await persist("annual_price_target_path", targetPath, [String(scenarioArtifact.id)]);
      const returnsArtifact = await persist("expected_return_matrix", expectedReturns, [String(pathArtifact.id), String(scenarioArtifact.id)]);

      const explanationResult = await callResearchAgent<{ valuation_explanation: Record<string, unknown> }>({
        sql, ctx, stageKey: "asset_valuation", taskKey: `valuation-explanation:${manifest.input_manifest_hash}`,
        taskType: "asset_valuation_explanation", agentName: "valuation-analyst", modelTier: "mid",
        packet: { valuation_explanation_request: true, input_manifest: manifestArtifact, methods: completed.map((item) => item.method), scenario_set: scenarioSet, reverse_valuation: reverseValuation, expected_return_matrix: expectedReturns },
        promptFactory: (value) => exactJsonPrompt({
          agentName: "valuation-analyst", requiredKeys: ["valuation_explanation"], packet: value,
          extraRules: ["Explain the supplied deterministic results. Do not create or alter numeric values."],
        }),
        outputFormat: VALUATION_EXPLANATION_CONTRACT,
      });
      await persist("valuation_explanation", explanationResult.valuation_explanation, [String(reverseArtifact.id), String(pathArtifact.id), String(returnsArtifact.id)]);
      await sql`
        UPDATE research_artifacts SET status = 'superseded', updated_at = NOW()
        WHERE research_run_id = ${ctx.runId} AND artifact_type = ANY(${ARTIFACT_KEYS as unknown as string[]})
          AND id <> ALL(${persistedIds}) AND status IN ('draft', 'validated', 'accepted', 'needs_more_work')
          AND COALESCE(content_json->>'input_manifest_hash', '') <> ${manifest.input_manifest_hash}
      `;

      const derivedScenarios = (["bear", "base", "bull"] as const).map((scenarioType) => ({
        scenario_name: `${scenarioType} valuation`, scenario_type: scenarioType,
        value_anchor: Number(scenarioSet[`terminal_anchor_${scenarioType}`]), probability: Number(scenarioSet[`probability_${scenarioType}`]),
        currency: manifest.market_currency, assumptions_json: { terminal_year: terminalYear }, confidence: scenarioType === "base" ? 0.7 : 0.55,
        valuation_model_run_id: completed[0].modelRunId,
      }));
      for (const scenario of derivedScenarios) {
        const updated = await sql`
          UPDATE scenarios SET scenario_name = ${scenario.scenario_name}, probability = ${scenario.probability},
            value_anchor = ${scenario.value_anchor}, currency = ${scenario.currency}, assumptions_json = ${JSON.stringify(scenario.assumptions_json)}::jsonb,
            confidence = ${scenario.confidence}, valuation_model_run_id = ${scenario.valuation_model_run_id}, review_status = 'accepted'
          WHERE research_run_id = ${ctx.runId} AND scenario_type = ${scenario.scenario_type}
        `;
        if (updated.count) continue;
        await sql`INSERT INTO scenarios (
          asset_id, research_run_id, scenario_name, scenario_type, probability, value_anchor, currency,
          assumptions_json, confidence, valuation_model_run_id, review_status
        ) VALUES (
          ${ctx.assetId}, ${ctx.runId}, ${scenario.scenario_name}, ${scenario.scenario_type}, ${scenario.probability}, ${scenario.value_anchor},
          ${scenario.currency}, ${JSON.stringify(scenario.assumptions_json)}::jsonb, ${scenario.confidence}, ${scenario.valuation_model_run_id}, 'accepted'
        )`;
      }
      const range = Object.fromEntries(derivedScenarios.map((scenario) => [scenario.scenario_type, scenario.value_anchor]));
      const updatedSignal = await sql`
        UPDATE valuation_signals SET current_value_text = ${String(scenarioSet.terminal_anchor_base)},
          comparison_range_json = ${JSON.stringify(range)}::jsonb, review_status = 'accepted'
        WHERE research_run_id = ${ctx.runId} AND signal_key = 'scenario_price_target_range'
      `;
      if (!updatedSignal.count) await sql`INSERT INTO valuation_signals (
          asset_id, research_run_id, profile_id, signal_key, signal_name, lens_family,
          current_value_text, comparison_range_json, signal, cheapness_score, confidence, review_status
        ) VALUES (
          ${ctx.assetId}, ${ctx.runId}, ${ctx.profileId}, 'scenario_price_target_range', 'Scenario price target range',
          'scenario_valuation', ${String(scenarioSet.terminal_anchor_base)}, ${JSON.stringify(range)}::jsonb, 'scenario_range', 0.5, 0.7, 'accepted'
        )`;
      for (const method of requiredMethods) {
        const signalKey = `${method}_scenario_price_target`;
        const updatedMethodSignal = await sql`
          UPDATE valuation_signals SET current_value_text = ${String(scenarioSet.terminal_anchor_base)},
            comparison_range_json = ${JSON.stringify(range)}::jsonb, lens_family = ${method}, review_status = 'accepted'
          WHERE research_run_id = ${ctx.runId} AND signal_key = ${signalKey}
        `;
        if (updatedMethodSignal.count) continue;
        await sql`INSERT INTO valuation_signals (
          asset_id, research_run_id, profile_id, signal_key, signal_name, lens_family,
          current_value_text, comparison_range_json, signal, cheapness_score, confidence, review_status
        ) VALUES (
          ${ctx.assetId}, ${ctx.runId}, ${ctx.profileId}, ${signalKey}, ${`${method.replace(/_/g, " ")} scenario price target`},
          ${method}, ${String(scenarioSet.terminal_anchor_base)}, ${JSON.stringify(range)}::jsonb,
          'inconclusive', 0.5, 0.65, 'accepted'
        )`;
      }
      return {
        valuation_input_manifest: manifestArtifact,
        valuation_method_run: { artifact_type: "valuation_method_run", primary_method_key: requiredMethods[0], methods: completed.map((item) => item.method) },
        valuation_scenario_set: scenarioSet, reverse_valuation: reverseValuation, annual_price_target_path: targetPath,
        expected_return_matrix: expectedReturns, valuation_explanation: explanationResult.valuation_explanation,
      };
    } finally { await sql.end(); }
  },
  async validate(ctx: ResearchRunContext, _output: unknown): Promise<ValidationResult> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const rows = await sql`
        SELECT artifact_type FROM research_artifacts WHERE research_run_id = ${ctx.runId}
          AND artifact_type = ANY(${ARTIFACT_KEYS as unknown as string[]}) AND status IN ('validated', 'accepted')
      `;
      const present = new Set(rows.map((row) => String(row.artifact_type)));
      return makeValidationResult(ARTIFACT_KEYS.filter((key) => !present.has(key)).map((key) => `Missing required artifact: ${key}`));
    } finally { await sql.end(); }
  },
};
