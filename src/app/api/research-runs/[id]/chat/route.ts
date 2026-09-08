import { NextRequest } from "next/server";
import { z } from "zod";
import { handleApiError, successResponse, ApiError } from "@/lib/api/errors";
import { getResearchRunReport } from "@/lib/research/artifacts/read-model";
import { evaluateResearchQuality } from "@/lib/workflow/quality-gates";
import { runResearchAgent } from "@/lib/agent-harness/runner";
import { getAgentConfig, resolveAgentModel } from "@/lib/agent-harness/registry";
import { assertModelBudgetAvailable, recordModelCall, releaseModelBudgetReservation } from "@/lib/agents/model-calls";
import {
  buildResearchAssistantPacket,
  buildResearchAssistantPrompt,
  enforceResearchDecisionCaveat,
  type GroundedAssistantContext,
} from "@/lib/research/grounded-assistant";

const chatRequestSchema = z.object({
  message: z.string().trim().min(1).max(2_000),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(4_000),
  })).max(12).default([]),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: runId } = await params;
    const body = chatRequestSchema.parse(await request.json());
    const report = await getResearchRunReport(runId, { includeProvenance: false });
    if (!report) throw new ApiError("Research run not found", 404, "NOT_FOUND");

    const quality = await evaluateResearchQuality(runId);
    const reviews = Array.isArray(report.read_models?.review_decisions)
      ? report.read_models.review_decisions
      : [];
    const context: GroundedAssistantContext = {
      assetName: String(report.asset?.canonical_name || "Research run"),
      assetKind: String(report.asset?.asset_kind || "unknown"),
      runStatus: String(report.run?.status || "unknown"),
      pipelineVersion: Number(report.run?.pipeline_version || 0),
      researchQuestion: String(report.run?.research_question || "Not recorded"),
      sourceCutoffAt: report.run?.source_cutoff_at ? String(report.run.source_cutoff_at) : null,
      marketDataCutoffAt: report.run?.market_data_cutoff_at ? String(report.run.market_data_cutoff_at) : null,
      decisionStatus: reviews[0]?.status ? String(reviews[0].status) : null,
      artifacts: (report.artifacts || []).map((artifact: any) => ({
        type: String(artifact.type || artifact.artifact_type || "unknown"),
        content: artifact.content ?? artifact.content_json ?? null,
      })),
      evidence: (report.read_models?.evidence || []) as unknown[],
      metrics: (report.read_models?.metrics || []) as unknown[],
      signals: (report.read_models?.valuation_signals || []) as unknown[],
      scenarios: (report.read_models?.scenarios || []) as unknown[],
      theses: (report.read_models?.theses || []) as unknown[],
      risks: (report.read_models?.risks || []) as unknown[],
      catalysts: (report.read_models?.catalysts || []) as unknown[],
      sources: (report.read_models?.sources || []) as unknown[],
      modelCalls: [],
      conversationHistory: body.history,
      quality: {
        status: quality.status,
        actionReadiness: quality.actionReadiness,
        errors: quality.errors,
        warnings: quality.warnings,
        counts: quality.counts,
      },
    };

    const agentName = "research-assistant" as const;
    const agentConfig = getAgentConfig(agentName);
    const packet = buildResearchAssistantPacket(body.message, context);
    const prompt = buildResearchAssistantPrompt(body.message, context);
    let reservationId: string | undefined;
    let recordedAttempts = 0;

    try {
      const result = await runResearchAgent<{ answer: string; status_caveat: string }>({
        agentName,
        title: `${agentName} ${context.assetName} ${runId}`,
        taskPacket: packet,
        prompt,
        policy: {
          totalTimeoutMs: 120_000,
          inactivityTimeoutMs: 45_000,
          maxOutputTokens: 4_000,
          maxAttempts: 2,
          maxRepairAttempts: 1,
        },
        hooks: {
          beforeAttempt: async () => {
            reservationId = await assertModelBudgetAvailable({
              researchRunId: runId,
              modelTier: agentConfig.modelTier,
              reserveUsd: Number(process.env.RESEARCH_CHAT_ATTEMPT_BUDGET_RESERVE_USD || process.env.RESEARCH_ATTEMPT_BUDGET_RESERVE_USD || 0.1),
            });
          },
          onAttemptComplete: async (attempt) => {
            recordedAttempts += 1;
            const attemptReservation = reservationId;
            const reconcileReservation = attempt.status === "success" || attempt.costUsd > 0;
            let persisted = false;
            try {
              await recordModelCall({
                researchRunId: runId,
                agentName,
                modelProvider: attempt.provider,
                modelName: attempt.model,
                modelTier: agentConfig.modelTier,
                promptVersion: agentConfig.promptVersion,
                inputTokens: attempt.inputTokens,
                outputTokens: attempt.outputTokens,
                costUsd: attempt.costUsd,
                costSource: attempt.costSource,
                latencyMs: attempt.latencyMs,
                status: attempt.status,
                errorMessage: attempt.errorMessage,
                requestMetadata: {
                  channel: "research_chat",
                  attempt: attempt.attempt,
                  fallback: attempt.fallback,
                  model_attempt: attempt.modelAttempt,
                  compaction_occurred: attempt.compactionOccurred,
                  input_bytes: attempt.inputBytes,
                  original_input_bytes: attempt.originalInputBytes,
                },
                responseMetadata: {
                  request_id: attempt.requestId,
                  started_at: attempt.startedAt,
                  completed_at: attempt.completedAt,
                  error_category: attempt.errorCategory,
                  timeout_type: attempt.timeoutType,
                  reasoning_tokens: attempt.reasoningTokens,
                  repair_attempted: attempt.repairAttempted,
                  validation_errors: attempt.validationErrors,
                  provider_requests: attempt.passes,
                  raw_response_excerpt: attempt.rawResponseExcerpt,
                },
                reservationId: reconcileReservation ? attemptReservation : undefined,
              });
              persisted = true;
            } finally {
              if (attemptReservation && (!reconcileReservation || !persisted)) {
                await releaseModelBudgetReservation(attemptReservation).catch(() => undefined);
              }
              reservationId = undefined;
            }
          },
        },
      });

      return successResponse({
        answer: enforceResearchDecisionCaveat(result.structured.answer, context),
        mode: "model_backed_grounded_assistant",
        decisionStatus: context.decisionStatus,
        usage: {
          provider: result.usage.provider,
          model: result.usage.model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          costUsd: result.usage.costUsd,
          costSource: result.usage.costSource,
        },
      });
    } catch (error) {
      if (reservationId) await releaseModelBudgetReservation(reservationId).catch(() => undefined);
      if (!recordedAttempts) {
        await recordModelCall({
          researchRunId: runId,
          agentName,
          modelProvider: process.env.RESEARCH_MODEL_PROVIDER || "local-harness",
          modelName: resolveAgentModel(agentName),
          modelTier: agentConfig.modelTier,
          promptVersion: agentConfig.promptVersion,
          status: "failed",
          errorMessage: error instanceof Error ? error.message : String(error),
          requestMetadata: { channel: "research_chat", pre_attempt_failure: true },
        }).catch(() => undefined);
      }
      throw error;
    }
  } catch (error) {
    return handleApiError(error);
  }
}
