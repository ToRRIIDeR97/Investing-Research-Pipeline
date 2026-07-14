import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import {
  getAgentConfig,
  resolveAgentModel,
  type ResearchAgentName,
  type ResearchAgentConfig,
} from "./agent-registry";

export interface OpenCodeUsage {
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  latencyMs: number;
  sessionId?: string;
  promptVersion?: string;
  compaction_occurred?: boolean;
}

export interface RunResearchAgentInput {
  agentName: ResearchAgentName;
  title: string;
  taskPacket: Record<string, unknown>;
  prompt?: string;
}

export interface RunResearchAgentResult<TStructured = unknown> {
  structured: TStructured;
  usage: OpenCodeUsage;
  config: ResearchAgentConfig;
}

export class ResearchAgentRunError extends Error {
  usage: OpenCodeUsage;
  responseMetadata: Record<string, unknown>;

  constructor(message: string, usage: OpenCodeUsage, responseMetadata: Record<string, unknown> = {}) {
    super(message);
    this.name = "ResearchAgentRunError";
    this.usage = usage;
    this.responseMetadata = responseMetadata;
  }
}

class OpenCodeTimeoutError extends Error {
  constructor(readonly timeoutMs: number, readonly sessionId?: string) {
    super(`OpenCode request timed out after ${timeoutMs}ms${sessionId ? ` (session ${sessionId})` : ""}`);
  }
}

function checkOpenCodeVersionCompatibility() {
  let sdkVersion = "1.17.13";
  try {
    const pkgPath = path.join(process.cwd(), "node_modules", "@opencode-ai/sdk", "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      sdkVersion = pkg.version;
    }
  } catch (err) {
    // Ignore and use default
  }

  let sidecarVersion = "";
  try {
    sidecarVersion = execSync("opencode --version", { encoding: "utf8" }).trim();
  } catch (err) {
    throw new Error(`Failed to query OpenCode sidecar version: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (sdkVersion !== sidecarVersion) {
    throw new Error(
      `OpenCode compatibility check failed: SDK version is ${sdkVersion} but sidecar version is ${sidecarVersion}. Please run 'opencode upgrade ${sdkVersion}' to align them.`
    );
  }
}

function classifyError(error: unknown): string {
  if (error instanceof OpenCodeTimeoutError) {
    return "provider_timeout";
  }
  if (error instanceof ResearchAgentRunError) {
    if (error.message.includes("JSON") || error.message.includes("structured output") || error.message.includes("schema")) {
      return "structured_output_validation_failure";
    }
    return "sidecar_protocol_failure";
  }
  const msg = error instanceof Error ? error.message : String(error);
  if (/abort|cancel/i.test(msg)) {
    return "operator_cancellation";
  }
  if (/timeout|timed out/i.test(msg)) {
    return "provider_timeout";
  }
  return "sidecar_protocol_failure";
}

export function assertOk<T>(result: { data?: T; error?: unknown }, operation: string): T {
  if (result.error) {
    throw new Error(`${operation} failed: ${JSON.stringify(result.error)}`);
  }
  if (result.data === undefined) {
    throw new Error(`${operation} returned no data`);
  }
  return result.data;
}

function getOpenCodeGoApiKey() {
  return process.env.OPENCODE_GO_API_KEY || process.env.OPENCODE_API_KEY || "";
}

async function syncOpenCodeCredentials(client: any) {
  const apiKey = getOpenCodeGoApiKey().trim();
  if (!apiKey) {
    if (process.env.OPENCODE_REQUIRE_MANAGED_AUTH === "true") {
      throw new Error(
        "OPENCODE_GO_API_KEY is required when OPENCODE_REQUIRE_MANAGED_AUTH=true"
      );
    }
    return;
  }

  const providerId = process.env.OPENCODE_GO_PROVIDER_ID || "opencode-go";
  assertOk(
    await client.auth.set({
      path: { id: providerId },
      query: { directory: process.cwd() },
      body: {
        type: "api",
        key: apiKey,
      },
    }),
    `OpenCode auth.set for ${providerId}`
  );
}

export function getStructuredOutput(
  promptData: unknown,
  requiredKeys: string[] = []
): unknown {
  const data = promptData as {
    info?: { structured?: unknown; error?: unknown; cost?: number; tokens?: unknown };
    parts?: Array<{ type?: string; text?: string }>;
  };
  if (data.info?.structured !== undefined) {
    if (hasRequiredKeys(data.info.structured, requiredKeys)) {
      return data.info.structured;
    }
    if (requiredKeys.length === 0) {
      return data.info.structured;
    }
  }

  const text = data.parts
    ?.map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("\n")
    .trim();

  if (text) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced?.[1] || text;
    const jsonObjects = extractJsonObjects(candidate);
    const parsedObjects: unknown[] = [];
    for (const json of jsonObjects) {
      try {
        const parsed = JSON.parse(json);
        parsedObjects.push(parsed);
        if (hasRequiredKeys(parsed, requiredKeys)) {
          return parsed;
        }
      } catch {
        // Keep scanning: generated code may contain non-JSON object literals.
      }
    }
    if (parsedObjects.length > 0 && requiredKeys.length === 0) return parsedObjects[0];
    if (parsedObjects.length > 0) {
      throw new Error(
        `OpenCode returned JSON, but none matched required keys: ${requiredKeys.join(", ")}`
      );
    }
  }

  if (data.info?.error) {
    throw new Error(`OpenCode structured output failed: ${JSON.stringify(data.info.error)}`);
  }

  throw new Error("OpenCode did not return structured output");
}

function hasRequiredKeys(value: unknown, requiredKeys: string[]) {
  if (requiredKeys.length === 0) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return requiredKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function extractJsonObjects(value: string): string[] {
  const objects: string[] = [];
  const start = value.indexOf("{");
  if (start === -1) return objects;

  let depth = 0;
  let inString = false;
  let escaped = false;
  let objectStart = -1;

  for (let i = start; i < value.length; i += 1) {
    const char = value[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) objectStart = i;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && objectStart !== -1) {
        objects.push(value.slice(objectStart, i + 1));
        objectStart = -1;
      }
    }
  }

  return objects;
}

function buildTaskPrompt(input: RunResearchAgentInput, config: ResearchAgentConfig) {
  if (input.prompt) return input.prompt;

  return [
    `Run Research OS agent: ${config.name}`,
    "",
    "Use the task packet below as the complete working context.",
    "Return only structured JSON matching the supplied schema.",
    "",
    "Task packet:",
    "```json",
    JSON.stringify(input.taskPacket, null, 2),
    "```",
  ].join("\n");
}

function responseExcerpt(promptResult: unknown) {
  const data = promptResult as { parts?: Array<{ text?: unknown }> };
  return (data.parts || [])
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join("\n")
    .slice(0, 12000);
}

function agentTimeoutMs(agentName: ResearchAgentName) {
  const specific = process.env[`OPENCODE_${agentName.toUpperCase().replace(/-/g, "_")}_TIMEOUT_MS`];
  const configured = Number(specific || process.env.OPENCODE_AGENT_TIMEOUT_MS || 240000);
  return Number.isFinite(configured) && configured >= 10000 ? configured : 240000;
}

function modelCandidates(agentName: ResearchAgentName) {
  const config = getAgentConfig(agentName);
  const primary = resolveAgentModel(agentName);
  const fallbackKey = `OPENCODE_${agentName.toUpperCase().replace(/-/g, "_")}_FALLBACK_MODEL`;
  const configuredFallback = process.env[fallbackKey];
  // Keep the fallback on a different provider family.  A duplicate model name
  // only repeats an upstream outage and does not provide real failover.
  const builtInFallbacks: Partial<Record<ResearchAgentName, string>> = {
    "asset-analyst": "qwen3.7-plus",
    // Kimi is useful for code-heavy valuation work, but a provider stall must
    // not strand the entire run. DeepSeek Pro is the independent fallback.
    "valuation-analyst": "deepseek-v4-pro",
  };
  const builtInFallback = builtInFallbacks[agentName];
  const fallbackModel = configuredFallback || builtInFallback;
  const fallback = fallbackModel ? resolveAgentModel(agentName, fallbackModel) : null;
  return [primary, fallback]
    .filter((model): model is NonNullable<typeof model> => Boolean(model))
    .filter((model, index, all) => all.findIndex((candidate) =>
      candidate.providerID === model.providerID && candidate.modelID === model.modelID
    ) === index)
    .map((model) => ({ model, config }));
}

function shouldFallback(error: unknown) {
  if (error instanceof OpenCodeTimeoutError) return true;
  // This runtime error represents an unusable structured response after its
  // in-session repair attempt. A second model is a meaningful recovery path.
  if (error instanceof ResearchAgentRunError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|fetch failed|ECONNRESET|ECONNREFUSED|socket|network|provider/i.test(message);
}

async function withinDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  sessionId?: string,
  onTimeout?: () => Promise<void> | void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(async () => {
      try {
        await Promise.resolve(onTimeout?.());
      } catch (err) {
        // ignore
      }
      reject(new OpenCodeTimeoutError(timeoutMs, sessionId));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function promptWithinDeadline(
  client: any,
  sessionId: string,
  request: Promise<unknown>,
  timeoutMs: number
) {
  return withinDeadline(request, timeoutMs, sessionId, async () => {
    try {
      await client.session.abort({
        path: { id: sessionId },
        query: { directory: process.cwd() },
      });
    } catch {
      // A timed-out sidecar should never prevent the application from
      // recording a terminal task state.
    }
  });
}

export async function runResearchAgent<TStructured = unknown>(
  input: RunResearchAgentInput
): Promise<RunResearchAgentResult<TStructured>> {
  checkOpenCodeVersionCompatibility();

  const baseUrl = process.env.OPENCODE_BASE_URL;
  if (!baseUrl) {
    throw new Error("OPENCODE_BASE_URL is required to run Research OS agents");
  }

  const config = getAgentConfig(input.agentName);
  const { createOpencodeClient } = await import("@opencode-ai/sdk");
  const client = createOpencodeClient({
    baseUrl,
    directory: process.cwd(),
  });

  await syncOpenCodeCredentials(client);
  const timeoutMs = agentTimeoutMs(input.agentName);
  const failures: Array<{ model: string; provider: string; message: string; sessionId?: string; attempt: number; error_type: string; latencyMs: number }> = [];

  let attempt = 0;
  const loopStarted = Date.now();
  for (const candidate of modelCandidates(input.agentName)) {
    attempt++;
    const started = Date.now();
    let sessionId: string | undefined;

    let currentInput = input;
    let compactionOccurred = false;
    if (attempt > 1 && input.agentName === "asset-analyst") {
      compactionOccurred = true;
      const taskPacketCopy = { ...input.taskPacket };
      if (Array.isArray(taskPacketCopy.evidence_claims)) {
        taskPacketCopy.evidence_claims = taskPacketCopy.evidence_claims.slice(0, 15);
      }
      if (Array.isArray(taskPacketCopy.metrics)) {
        taskPacketCopy.metrics = taskPacketCopy.metrics.slice(0, 20);
      }
      currentInput = {
        ...input,
        taskPacket: taskPacketCopy,
      };
    }

    try {
      const session = assertOk(
        await withinDeadline(
          client.session.create({
            body: { title: input.title },
            query: { directory: process.cwd() },
          }),
          timeoutMs,
          undefined
        ),
        "OpenCode session.create"
      ) as { id: string };
      sessionId = session.id;

      const promptResult = assertOk(
        await promptWithinDeadline(
          client,
          session.id,
          client.session.prompt({
            path: { id: session.id },
            query: { directory: process.cwd() },
            body: {
              agent: config.name,
              model: candidate.model,
              tools: config.tools,
              parts: [{ type: "text", text: buildTaskPrompt(currentInput, config) }],
              format: config.outputFormat,
            },
          } as any),
          timeoutMs
        ) as { data?: unknown; error?: unknown },
        "OpenCode session.prompt"
      );

      let finalPromptResult = promptResult;
      let repairAttempted = false;
      try {
        getStructuredOutput(promptResult, getRequiredOutputKeys(config.outputFormat));
      } catch (firstError) {
        repairAttempted = true;
        finalPromptResult = assertOk(
          await promptWithinDeadline(
            client,
            session.id,
            client.session.prompt({
              path: { id: session.id },
              query: { directory: process.cwd() },
              body: {
                agent: config.name,
                model: candidate.model,
                tools: config.tools,
                parts: [{
                  type: "text",
                  text: [
                    "Your previous response did not satisfy the required structured-output schema.",
                    `Validation error: ${firstError instanceof Error ? firstError.message : String(firstError)}`,
                    "Repair it now. Return exactly one JSON object with every required top-level key.",
                    "Use empty arrays or objects where data is unavailable. Do not include Markdown or prose.",
                  ].join("\n"),
                }],
                format: config.outputFormat,
              },
            } as any),
            timeoutMs
          ) as { data?: unknown; error?: unknown },
          "OpenCode structured-output repair prompt"
        );
      }

      const info = (finalPromptResult as any).info || {};
      const tokens = info.tokens || {};
      const usage: OpenCodeUsage = {
        provider: info.providerID || candidate.model.providerID,
        model: info.modelID || candidate.model.modelID,
        inputTokens: typeof tokens.input === "number" ? tokens.input : undefined,
        outputTokens: typeof tokens.output === "number" ? tokens.output : undefined,
        costUsd: typeof info.cost === "number" ? info.cost : undefined,
        latencyMs: Date.now() - started,
        sessionId: session.id,
        promptVersion: config.promptVersion,
        compaction_occurred: compactionOccurred,
      };
      let structured: TStructured;
      try {
        structured = getStructuredOutput(
          finalPromptResult,
          getRequiredOutputKeys(config.outputFormat)
        ) as TStructured;
      } catch (error) {
        throw new ResearchAgentRunError(
          error instanceof Error ? error.message : String(error),
          usage,
          {
            session_id: session.id,
            repair_attempted: repairAttempted,
            initial_response_excerpt: responseExcerpt(promptResult),
            final_response_excerpt: responseExcerpt(finalPromptResult),
            compaction_occurred: compactionOccurred,
          }
        );
      }
      return { structured, config, usage };
    } catch (error) {
      const errorType = classifyError(error);
      const elapsed = Date.now() - started;
      const formattedMsg = `[Session: ${sessionId || "none"}, Model: ${candidate.model.modelID}, Provider: ${candidate.model.providerID}, Attempt: ${attempt}, Elapsed: ${elapsed}ms] ${error instanceof Error ? error.message : String(error)}`;
      failures.push({
        model: candidate.model.modelID,
        provider: candidate.model.providerID,
        message: formattedMsg,
        sessionId,
        attempt,
        error_type: errorType,
        latencyMs: elapsed,
      });

      if (!shouldFallback(error)) {
        const wrappedError = new Error(formattedMsg);
        (wrappedError as any).usage = {
          provider: candidate.model.providerID,
          model: candidate.model.modelID,
          latencyMs: elapsed,
          sessionId,
          promptVersion: config.promptVersion,
          compaction_occurred: compactionOccurred,
        };
        (wrappedError as any).responseMetadata = {
          session_id: sessionId,
          attempt,
          error_type: errorType,
          compaction_occurred: compactionOccurred,
        };
        throw wrappedError;
      }
    }
  }

  const last = failures[failures.length - 1];
  const totalLatency = Date.now() - loopStarted;
  throw new ResearchAgentRunError(
    `OpenCode model attempts exhausted: ${failures.map((failure) => `${failure.model}: ${failure.message}`).join(" | ")}`,
    {
      provider: process.env.OPENCODE_GO_PROVIDER_ID || "opencode-go",
      model: last?.model || "unknown",
      latencyMs: totalLatency,
      promptVersion: config.promptVersion,
    },
    { attempts: failures }
  );
}

function getRequiredOutputKeys(outputFormat: Record<string, unknown>) {
  const schema = outputFormat.schema as { required?: unknown } | undefined;
  return Array.isArray(schema?.required)
    ? schema.required.filter((key): key is string => typeof key === "string")
    : [];
}
