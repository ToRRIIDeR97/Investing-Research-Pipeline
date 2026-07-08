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

export async function runResearchAgent<TStructured = unknown>(
  input: RunResearchAgentInput
): Promise<RunResearchAgentResult<TStructured>> {
  const baseUrl = process.env.OPENCODE_BASE_URL;
  if (!baseUrl) {
    throw new Error("OPENCODE_BASE_URL is required to run Research OS agents");
  }

  const started = Date.now();
  const config = getAgentConfig(input.agentName);
  const model = resolveAgentModel(input.agentName);
  const { createOpencodeClient } = await import("@opencode-ai/sdk");
  const client = createOpencodeClient({
    baseUrl,
    directory: process.cwd(),
  });

  await syncOpenCodeCredentials(client);

  const session = assertOk(
    await client.session.create({
      body: {
        title: input.title,
      },
      query: { directory: process.cwd() },
    }),
    "OpenCode session.create"
  ) as { id: string };

  const promptResult = assertOk(
    await client.session.prompt({
      path: { id: session.id },
      query: { directory: process.cwd() },
      body: {
        agent: config.name,
        model,
        tools: config.tools,
        parts: [{ type: "text", text: buildTaskPrompt(input, config) }],
        format: config.outputFormat,
      },
    } as any),
    "OpenCode session.prompt"
  );

  const info = (promptResult as any).info || {};
  const tokens = info.tokens || {};

  return {
    structured: getStructuredOutput(
      promptResult,
      getRequiredOutputKeys(config.outputFormat)
    ) as TStructured,
    config,
    usage: {
      provider: info.providerID || model.providerID,
      model: info.modelID || model.modelID,
      inputTokens: typeof tokens.input === "number" ? tokens.input : undefined,
      outputTokens: typeof tokens.output === "number" ? tokens.output : undefined,
      costUsd: typeof info.cost === "number" ? info.cost : undefined,
      latencyMs: Date.now() - started,
      sessionId: session.id,
      promptVersion: config.promptVersion,
    },
  };
}

function getRequiredOutputKeys(outputFormat: Record<string, unknown>) {
  const schema = outputFormat.schema as { required?: unknown } | undefined;
  return Array.isArray(schema?.required)
    ? schema.required.filter((key): key is string => typeof key === "string")
    : [];
}
