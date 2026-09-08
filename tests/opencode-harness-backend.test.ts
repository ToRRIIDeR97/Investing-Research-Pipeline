import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { createDeadlineController } from "../src/lib/agent-harness/deadlines";
import { ProviderError, ResearchAgentRunError } from "../src/lib/agent-harness/errors";
import {
  compactMessages,
  createMessage,
  safeJson,
  textMessage,
  toAnthropicMessages,
  toOpenAIChatMessages,
} from "../src/lib/agent-harness/messages";
import { RemoteMcpClient } from "../src/lib/agent-harness/mcp";
import { evaluatePermission, PermissionService } from "../src/lib/agent-harness/permissions";
import { AnthropicCompatibleProvider } from "../src/lib/agent-harness/providers/anthropic-compatible";
import { runResearchAgent } from "../src/lib/agent-harness/runner";
import { MemoryAgentSessionStore } from "../src/lib/agent-harness/session-store";
import { discoverSkills, renderSkillContext, selectSkills } from "../src/lib/agent-harness/skills";
import { registerSubagentTool } from "../src/lib/agent-harness/subagents";
import { registerTool, ToolRegistry } from "../src/lib/agent-harness/tools";
import type { ModelEvent, ModelProvider, ModelRequest, PermissionRequest } from "../src/lib/agent-harness/types";

process.env.RESEARCH_VISION_MODEL = "test-default-model";

test("canonical messages lower tool calls and results for OpenAI and Anthropic", () => {
  const messages = [
    textMessage("system", "trusted system"),
    textMessage("user", "find the metric"),
    createMessage("assistant", [{
      type: "tool_call",
      call: { id: "call-1", name: "lookup", arguments: '{"metric":"roe"}' },
    }]),
    createMessage("tool", [{
      type: "tool_result", toolCallId: "call-1", toolName: "lookup", output: { value: 12.5 },
    }]),
  ];

  const openai = toOpenAIChatMessages(messages) as any[];
  assert.equal(openai[2].tool_calls[0].id, "call-1");
  assert.equal(openai[3].tool_call_id, "call-1");

  const anthropic = toAnthropicMessages(messages);
  assert.equal(anthropic.system, "trusted system");
  assert.equal((anthropic.messages[1].content[0] as any).type, "tool_use");
  assert.equal((anthropic.messages[2].content[0] as any).tool_use_id, "call-1");
  assert.throws(() => toAnthropicMessages([textMessage("system", "system only")]), /at least one user or assistant/);
});

test("message media is data-only, MIME checked, and bounded", () => {
  const remote = createMessage("user", [{ type: "image", url: "https://example.com/x.png" }]);
  assert.throws(() => toOpenAIChatMessages([remote]), /Remote or unsupported image URLs/);
  const malformed = createMessage("user", [{ type: "image", url: "data:image/png;base64,not-base64!" }]);
  assert.throws(() => toOpenAIChatMessages([malformed]), /Remote or unsupported image URLs/);
  assert.throws(() => safeJson(undefined), /not JSON serializable/);
});

test("context compaction keeps tool calls and results as an atomic pair", () => {
  const call = createMessage("assistant", [{
    type: "tool_call", call: { id: "pair-1", name: "lookup", arguments: "{}" },
  }]);
  const result = createMessage("tool", [{
    type: "tool_result", toolCallId: "pair-1", toolName: "lookup", output: "result",
  }]);
  const messages = [
    textMessage("system", "trusted"),
    call,
    result,
    ...Array.from({ length: 6 }, (_, index) => textMessage("user", `${index}:${"x".repeat(2_000)}`)),
  ];
  const compacted = compactMessages(messages, 7_000);
  assert.equal(compacted.compacted, true);
  const hasCall = compacted.messages.some((message) => message.id === call.id);
  const hasResult = compacted.messages.some((message) => message.id === result.id);
  assert.equal(hasCall, hasResult);
  assert.equal(compacted.messages.filter((message) => message.role === "system").length, 1);
});

test("memory session events are ordered, idempotent, and terminal sessions reject new work", async () => {
  const store = new MemoryAgentSessionStore();
  const session = await store.createSession({ taskId: "task-1", agentName: "research-assistant" });
  await store.updateSession(session.id, { status: "running" });
  const first = await store.appendEvent(session.id, "step.started", { attempt: 1, model: "test" }, { idempotencyKey: "step:1" });
  const replay = await store.appendEvent(session.id, "step.started", { model: "test", attempt: 1 }, { idempotencyKey: "step:1" });
  assert.equal(first.id, replay.id);
  await assert.rejects(
    store.appendEvent(session.id, "step.started", { attempt: 2 }, { idempotencyKey: "step:1" }),
    /Conflicting replay/
  );
  await store.updateSession(session.id, { status: "completed", result: { structured: { ok: true } } });
  await assert.rejects(store.appendEvent(session.id, "new.work"), /already completed/);
  assert.deepEqual((await store.createSession({ taskId: "task-1", agentName: "research-assistant" })).result, {
    structured: { ok: true },
  });
});

test("permission rules use last match and allow-always is scoped to the service", async () => {
  const rules = [
    { action: "tool:*", resource: "*", effect: "deny" as const },
    { action: "tool:read", resource: "source:*", effect: "ask" as const },
  ];
  assert.equal(evaluatePermission(rules, "tool:read", "source:10"), "ask");
  let prompts = 0;
  const service = new PermissionService(rules, async () => {
    prompts += 1;
    return "allow_always" as const;
  });
  const request: PermissionRequest = {
    id: "permission-1", sessionId: "session-1", agentName: "research-assistant",
    toolCallId: "call-1", toolName: "read", action: "tool:read", resource: "source:10", input: {},
  };
  await service.authorize(request, new AbortController().signal);
  await service.authorize({ ...request, id: "permission-2", toolCallId: "call-2" }, new AbortController().signal);
  assert.equal(prompts, 1);
  const invalid = new PermissionService([], async () => "invalid" as any);
  await assert.rejects(invalid.authorize(request, new AbortController().signal), /invalid decision/);
});

test("typed tools validate input, bound output, persist settlement, and honor timeout", async () => {
  const registry = new ToolRegistry();
  const store = new MemoryAgentSessionStore();
  const session = await store.createSession({ agentName: "research-assistant" });
  registry.register({
    name: "bounded",
    description: "bounded output",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["value"],
      properties: { value: { type: "string" } },
    },
    inputValidator: z.object({ value: z.string() }).strict(),
    outputValidator: z.object({ text: z.string() }),
    maxOutputBytes: 180,
    execute: async ({ value }) => ({ text: value.repeat(500) }),
  });
  registry.register({
    name: "slow",
    description: "times out",
    inputSchema: { type: "object", additionalProperties: false },
    timeoutMs: 5,
    execute: async (_input, context) => new Promise((_resolve, reject) => {
      context.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });
  const tools = registry.materialize({
    agentName: "research-assistant", sessionId: session.id, signal: new AbortController().signal,
    enabledTools: ["bounded", "slow"], store, defaultTimeoutMs: 50, defaultMaxOutputBytes: 1_000,
    permissionRules: [{ action: "tool:*", resource: "*", effect: "allow" }],
  });
  await assert.rejects(
    tools.execute({ id: "bad", name: "bounded", arguments: '{"value":1}' }),
    /Invalid arguments/
  );
  const bounded = await tools.execute({ id: "bounded-1", name: "bounded", arguments: '{"value":"é"}' });
  assert.equal(bounded.truncated, true);
  assert.ok(Buffer.byteLength(safeJson(bounded.output), "utf8") <= 180);
  assert.equal(store.toolTraces.get(`${session.id}:bounded-1`)?.status, "completed");
  await assert.rejects(
    tools.execute({ id: "slow-1", name: "slow", arguments: "{}" }),
    (error: unknown) => error instanceof ProviderError && error.category === "provider_timeout"
  );
});

test("runner sends protocol tool history and reuses a persisted completed result", async () => {
  class ToolProvider implements ModelProvider {
    readonly id = "tool-provider";
    requests: ModelRequest[] = [];
    locked = false;
    async acquireRequestLock() {
      assert.equal(this.locked, false);
      this.locked = true;
      return () => { this.locked = false; };
    }
    stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      this.requests.push(request);
      const call = this.requests.length;
      return (async function* () {
        yield { type: "response.started", requestId: `request-${call}` } as ModelEvent;
        if (call === 1) {
          yield { type: "tool.call", call: { id: "lookup-1", name: "lookup", arguments: '{"key":"roe"}' } } as ModelEvent;
        } else {
          yield { type: "text.delta", text: '{"ok":true}' } as ModelEvent;
        }
        yield { type: "response.completed", finishReason: "stop" } as ModelEvent;
      })();
    }
  }

  const provider = new ToolProvider();
  const unregister = registerTool({
    name: "lookup",
    description: "lookup metric",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["key"],
      properties: { key: { type: "string" } },
    },
    execute: async ({ key }: { key: string }) => {
      assert.equal(provider.locked, false);
      return { key, value: 12.5 };
    },
  });
  const store = new MemoryAgentSessionStore();
  const input = {
    agentName: "research-assistant",
    title: "tool protocol",
    taskPacket: {},
    prompt: "Return JSON after using the tool",
    provider,
    enabledTools: ["lookup"],
    permissionRules: [{ action: "tool:lookup", resource: "*", effect: "allow" as const }],
    session: { id: "00000000-0000-4000-8000-000000000001", inputId: "input-1", store },
    policy: { maxAttempts: 1, maxRepairAttempts: 0, retryBaseDelayMs: 1 },
    outputFormat: {
      requiredKeys: ["ok"],
      schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } },
    },
  };
  try {
    const first = await runResearchAgent<{ ok: boolean }>(input);
    assert.equal(first.structured.ok, true);
    assert.equal(provider.requests.length, 2);
    const secondTurn = provider.requests[1].messages || [];
    assert.ok(secondTurn.some((message) => message.parts.some((part) => part.type === "tool_call")));
    assert.ok(secondTurn.some((message) => message.parts.some((part) => part.type === "tool_result")));
    assert.doesNotMatch(provider.requests[1].prompt, /Tool results:/);
    assert.ok((await store.listEvents(first.sessionId!)).some((event) => event.type === "session.completed"));

    const replay = await runResearchAgent<{ ok: boolean }>({ ...input, provider: undefined });
    assert.deepEqual(replay.structured, { ok: true });
    assert.equal(provider.requests.length, 2);
  } finally {
    unregister();
  }
});

test("a cancelled tool turn persists a matching error result", async () => {
  const provider: ModelProvider = {
    id: "cancelled-tool-provider",
    stream: () => (async function* () {
      yield { type: "response.started", requestId: "cancelled-tool" } as ModelEvent;
      yield { type: "tool.call", call: { id: "cancelled-call", name: "cancelled_tool", arguments: "{}" } } as ModelEvent;
      yield { type: "response.completed" } as ModelEvent;
    })(),
  };
  const unregister = registerTool({
    name: "cancelled_tool",
    description: "cancel",
    inputSchema: { type: "object", additionalProperties: false },
    execute: async () => { throw new ProviderError("cancelled", "cancellation"); },
  });
  const store = new MemoryAgentSessionStore();
  const sessionId = "00000000-0000-4000-8000-000000000003";
  try {
    await assert.rejects(runResearchAgent({
      agentName: "research-assistant",
      title: "cancelled tool",
      taskPacket: {},
      prompt: "Use the tool",
      provider,
      enabledTools: ["cancelled_tool"],
      permissionRules: [{ action: "tool:cancelled_tool", resource: "*", effect: "allow" }],
      session: { id: sessionId, inputId: "cancelled-input", store },
      policy: { maxAttempts: 1, maxRepairAttempts: 0 },
      outputFormat: { requiredKeys: ["ok"], schema: { type: "object", required: ["ok"] } },
    }));
    const messages = await store.listMessages(sessionId);
    assert.ok(messages.some((message) => message.parts.some((part) => part.type === "tool_call" && part.call.id === "cancelled-call")));
    assert.ok(messages.some((message) => message.parts.some((part) => part.type === "tool_result" && part.toolCallId === "cancelled-call" && part.isError)));
  } finally {
    unregister();
  }
});

test("a failed durable session replays prior assistant and tool messages on resume", async () => {
  class ResumeProvider implements ModelProvider {
    readonly id = "resume-provider";
    calls = 0;
    resumedMessages: ModelRequest["messages"];
    stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      this.calls += 1;
      const call = this.calls;
      if (call === 3) this.resumedMessages = request.messages;
      return (async function* () {
        yield { type: "response.started", requestId: `resume-${call}` } as ModelEvent;
        if (call === 1) {
          yield { type: "tool.call", call: { id: "resume-tool", name: "resume_lookup", arguments: "{}" } } as ModelEvent;
          yield { type: "response.completed" } as ModelEvent;
          return;
        }
        if (call === 2) {
          yield { type: "response.failed", error: new ProviderError("temporary", "server_error") } as ModelEvent;
          return;
        }
        yield { type: "text.delta", text: '{"ok":true}' } as ModelEvent;
        yield { type: "response.completed" } as ModelEvent;
      })();
    }
  }
  const provider = new ResumeProvider();
  const unregister = registerTool({
    name: "resume_lookup", description: "resume lookup",
    inputSchema: { type: "object", additionalProperties: false },
    execute: async () => ({ value: 1 }),
  });
  const store = new MemoryAgentSessionStore();
  const request = {
    agentName: "research-assistant",
    title: "resume",
    taskPacket: {},
    prompt: "Return JSON",
    provider,
    enabledTools: ["resume_lookup"],
    permissionRules: [{ action: "tool:resume_lookup", resource: "*", effect: "allow" as const }],
    session: { id: "00000000-0000-4000-8000-000000000002", inputId: "resume-input", store },
    policy: { maxAttempts: 1, maxRepairAttempts: 0, retryBaseDelayMs: 1 },
    outputFormat: {
      requiredKeys: ["ok"],
      schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
    },
  };
  try {
    await assert.rejects(runResearchAgent(request), ResearchAgentRunError);
    request.taskPacket = { revision: true };
    const result = await runResearchAgent<{ ok: boolean }>(request);
    assert.equal(result.structured.ok, true);
    assert.ok(provider.resumedMessages?.some((message) => message.parts.some((part) => part.type === "tool_call")));
    assert.ok(provider.resumedMessages?.some((message) => message.parts.some((part) => part.type === "tool_result")));
  } finally {
    unregister();
  }
});

test("a successful model response is not retried when attempt persistence fails", async () => {
  let calls = 0;
  const provider: ModelProvider = {
    id: "hook-failure",
    stream: () => (async function* () {
      calls += 1;
      yield { type: "response.started", requestId: "hook-1" } as ModelEvent;
      yield { type: "text.delta", text: '{"ok":true}' } as ModelEvent;
      yield { type: "response.completed" } as ModelEvent;
    })(),
  };
  await assert.rejects(runResearchAgent({
    agentName: "research-assistant",
    title: "hook failure",
    taskPacket: {},
    prompt: "Return JSON",
    provider,
    policy: { maxAttempts: 3, maxRepairAttempts: 0, retryBaseDelayMs: 1 },
    outputFormat: {
      requiredKeys: ["ok"],
      schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
    },
    hooks: { onAttemptComplete: async () => { throw new Error("database unavailable"); } },
  }), (error: unknown) => error instanceof ResearchAgentRunError && error.responseMetadata.persistence_failure === true);
  assert.equal(calls, 1);
});

test("a failed model response is not retried when attempt persistence fails", async () => {
  let calls = 0;
  const provider: ModelProvider = {
    id: "failed-hook",
    stream: () => (async function* () {
      calls += 1;
      yield { type: "response.started", requestId: "failed-hook-1" } as ModelEvent;
      yield { type: "response.failed", error: new ProviderError("temporary", "server_error") } as ModelEvent;
    })(),
  };
  await assert.rejects(runResearchAgent({
    agentName: "research-assistant",
    title: "failed hook",
    taskPacket: {},
    prompt: "Return JSON",
    provider,
    policy: { maxAttempts: 3, maxRepairAttempts: 0, retryBaseDelayMs: 1 },
    outputFormat: { requiredKeys: ["ok"], schema: { type: "object", required: ["ok"] } },
    hooks: { onAttemptComplete: async () => { throw new Error("database unavailable"); } },
  }), (error: unknown) => error instanceof ResearchAgentRunError && error.responseMetadata.persistence_failure === true);
  assert.equal(calls, 1);
});

test("invalid execution policy fails before provider execution", async () => {
  let calls = 0;
  const provider: ModelProvider = {
    id: "invalid-policy",
    stream: () => (async function* () { calls += 1; })(),
  };
  await assert.rejects(runResearchAgent({
    agentName: "research-assistant",
    title: "invalid policy",
    taskPacket: {},
    provider,
    policy: { maxAttempts: 0 },
    outputFormat: { requiredKeys: ["ok"] },
  }), (error: unknown) => error instanceof ProviderError && error.category === "invalid_request");
  await assert.rejects(runResearchAgent({
    agentName: "research-assistant",
    title: "invalid depth",
    taskPacket: {},
    provider,
    session: { depth: -1 },
    outputFormat: { requiredKeys: ["ok"] },
  }), (error: unknown) => error instanceof ProviderError && error.category === "invalid_request");
  assert.equal(calls, 0);
});

test("Anthropic tool deltas assemble valid JSON arguments", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response([
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call-1","name":"lookup","input":{}}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"key\\":\\"roe\\"}"}}',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}',
    'data: {"type":"message_stop"}',
    "",
  ].join("\n\n"), { status: 200 });
  try {
    const provider = new AnthropicCompatibleProvider({
      baseUrl: "https://api.example.test", apiKey: "test-key", allowedHosts: ["api.example.test"],
    });
    const calls: string[] = [];
    for await (const event of provider.stream({ model: "test", prompt: "test" }, new AbortController().signal)) {
      if (event.type === "tool.call") calls.push(event.call.arguments);
    }
    assert.deepEqual(calls, ['{"key":"roe"}']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MCP rejects insecure and private endpoints before connecting", () => {
  assert.throws(() => new RemoteMcpClient({ name: "bad", url: "http://example.com/mcp", allowedHosts: ["example.com"] }), /HTTPS/);
  assert.throws(() => new RemoteMcpClient({ name: "local", url: "https://127.0.0.1/mcp", allowedHosts: ["127.0.0.1"] }), /allowlisted/);
  assert.throws(() => new RemoteMcpClient({ name: "local-dot", url: "https://localhost./mcp", allowedHosts: ["localhost."] }), /allowlisted/);
});

test("local skills are bounded and explicit subagents inherit cancellation context", async () => {
  const root = await mkdtemp(join(tmpdir(), "research-skills-"));
  try {
    await mkdir(join(root, "one"));
    await mkdir(join(root, "two"));
    await writeFile(join(root, "one", "SKILL.md"), "---\nname: one\ndescription: First\n---\nUse source IDs.");
    await writeFile(join(root, "two", "SKILL.md"), "---\nname: two\ndescription: Second\n---\nUse citations.");
    const skills = await discoverSkills({ roots: [root], maxSkills: 1 });
    assert.equal(skills.length, 1);
    assert.match(renderSkillContext(selectSkills(skills, [skills[0].name])), /<skill/);

    const registry = new ToolRegistry();
    let delegatedDepth = 0;
    const registration = registerSubagentTool({
      registry,
      parentSessionId: "parent",
      parentDepth: 0,
      config: {
        allowedAgents: ["research-assistant"],
        execute: async (request) => {
          delegatedDepth = request.depth;
          assert.equal(request.signal.aborted, false);
          return { ok: true };
        },
      },
    });
    const tools = registry.materialize({
      agentName: "research-assistant", sessionId: "parent", signal: new AbortController().signal,
      enabledTools: [registration.toolName],
      permissionRules: [{ action: "subagent", resource: "*", effect: "allow" }],
      defaultTimeoutMs: 100, defaultMaxOutputBytes: 1_000,
    });
    const result = await tools.execute({
      id: "child-1", name: registration.toolName,
      arguments: '{"agentName":"research-assistant","title":"Check","taskPacket":{}}',
    });
    assert.deepEqual(result.output, { ok: true });
    assert.equal(delegatedDepth, 1);
    registration.unregister();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an already-aborted parent cancels a deadline immediately", () => {
  const parent = new AbortController();
  parent.abort();
  const deadline = createDeadlineController(parent.signal, 1_000, 1_000);
  assert.equal(deadline.signal.aborted, true);
  assert.equal(deadline.reason(), "caller");
  deadline.cleanup();
});
