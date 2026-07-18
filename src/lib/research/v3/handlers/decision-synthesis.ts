import type { V3RunContext, V3StageHandler, ValidationResult } from "../../v3-context";
import { v3ValidationResult } from "../../v3-context";
import { callV3Agent, v3ExactJsonPrompt } from "../../v3-context";
import { createArtifactRepository } from "../../artifacts/repository";
import { schema } from "@/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const DECISION_OUTPUT_KEYS = [
  "thesis",
  "risks",
  "catalysts",
  "expected_returns",
  "monitoring_thresholds",
];

export const decisionSynthesisHandler: V3StageHandler<unknown> = {
  stageKey: "decision_synthesis",
  async execute(ctx: V3RunContext): Promise<unknown> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const taskKey = "asset-analyst:decision";
      const packet = {
        asset: {
          runId: ctx.runId,
          assetId: ctx.assetId,
          assetName: ctx.assetName,
          symbol: ctx.symbol,
          profileKey: ctx.profileKey,
        },
        required_modules: ["thesis_synthesis"],
      };

      const promptFactory = (p: Record<string, unknown>) => v3ExactJsonPrompt({
        agentName: "asset-analyst",
        requiredKeys: DECISION_OUTPUT_KEYS,
        packet: p,
        extraRules: [
          "Synthesize the final investment decision, including a clear thesis statement, risk factors, and upcoming catalysts.",
        ],
      });

      const output = await callV3Agent<Record<string, any>>({
        sql, ctx, stageKey: "decision_synthesis", taskKey,
        taskType: "decision_synthesis", agentName: "asset-analyst", modelTier: "mid",
        packet, promptFactory,
      });

      // 4. Persist to theses table
      const thesis = output.thesis as any || {};
      await sql`
        INSERT INTO theses (
          asset_id, research_run_id, one_sentence_thesis, why_now, market_missing, status, created_by
        ) VALUES (
          ${ctx.assetId}, ${ctx.runId}, ${thesis.one_sentence_thesis || "Thesis statement"},
          ${thesis.why_now || null}, ${thesis.market_missing || null}, 'draft', 'system-v3'
        )
      `;

      // 5. Persist to risks table
      const risks = Array.isArray(output.risks) ? output.risks : [];
      for (const r of risks) {
        await sql`
          INSERT INTO risks (
            asset_id, research_run_id, risk_name, risk_type, description, severity, probability,
            evidence_claim_ids, mitigants_json
          ) VALUES (
            ${ctx.assetId}, ${ctx.runId}, ${r.risk_name || "Risk factor"}, ${r.risk_type || "market"},
            ${r.description || null}, ${r.severity || "medium"}, ${r.probability || "medium"},
            ${sql.array([])}, ${sql.json([])}
          )
        `;
      }

      // 6. Persist to catalysts table
      const catalysts = Array.isArray(output.catalysts) ? output.catalysts : [];
      for (const cat of catalysts) {
        await sql`
          INSERT INTO catalysts (
            asset_id, research_run_id, catalyst_name, catalyst_type, description, upside_downside, status
          ) VALUES (
            ${ctx.assetId}, ${ctx.runId}, ${cat.catalyst_name || "Catalyst event"}, ${cat.catalyst_type || "earnings"},
            ${cat.description || null}, ${cat.upside_downside || "neutral"}, 'open'
          )
        `;
      }

      // Persist decision artifacts
      const db = drizzle(sql, { schema });
      const repo = createArtifactRepository(db);
      const subKeys = [
        "investment_thesis",
        "risk_register",
        "catalyst_register",
        "expected_return_matrix",
        "thesis_breakers",
        "monitoring_dashboard",
        "confidence_assessment",
        "decision_record"
      ];
      for (const k of subKeys) {
        if (output[k]) {
          await repo.upsertArtifact({
            research_run_id: ctx.runId,
            asset_id: ctx.assetId,
            profile_id: ctx.profileId || undefined,
            artifact_type: k,
            scope_key: `${ctx.assetSlug}-${k.replace(/_/g, "-")}`,
            status: "accepted",
            content_json: output[k],
            schema_version: "3.0.0",
            validator_version: "1.0.0",
            prompt_version: "v3",
            created_by: "system-v3",
            idempotency_key: `${ctx.runId}-${k}`,
          });
        }
      }

      return output;
    } finally {
      await sql.end();
    }
  },
  async validate(ctx: V3RunContext, output: any): Promise<ValidationResult> {
    const sql = postgres(process.env.DATABASE_URL!);
    try {
      const ts = await sql`SELECT COUNT(*) as cnt FROM theses WHERE research_run_id = ${ctx.runId}`;
      const rs = await sql`SELECT COUNT(*) as cnt FROM risks WHERE research_run_id = ${ctx.runId}`;
      const cs = await sql`SELECT COUNT(*) as cnt FROM catalysts WHERE research_run_id = ${ctx.runId}`;
      const errors: string[] = [];
      if (Number(ts[0].cnt) === 0) errors.push("No thesis created for this run");
      if (Number(rs[0].cnt) === 0) errors.push("No risks documented for this run");
      if (Number(cs[0].cnt) === 0) errors.push("No catalysts documented for this run");
      return v3ValidationResult(errors);
    } finally {
      await sql.end();
    }
  }
};
