import assert from "node:assert/strict";
import test from "node:test";
import { ResearchAgentRunError } from "../src/lib/agent-harness/errors";
import { isTransientAgentError, settleBatch } from "../src/lib/research/pipeline-runner";
import { ResearchRequestsPending } from "../src/lib/research/team";
import { pollUntilStopped, withRetries } from "../src/workers/poll-loop";
import type { ValidationResult } from "../src/lib/workflow/validators";

const agentError = (errorType: string) => new ResearchAgentRunError(`Agent attempts exhausted: ${errorType}`, {} as any, { error_type: errorType });
const valid: ValidationResult = { valid: true, errors: [], warnings: [], checkedAt: new Date(0).toISOString() };

test("a stage that finished is advanced even when a sibling earlier in the batch failed", async () => {
  const advanced: string[] = [];
  const notes: string[] = [];
  const failure = new Error("historical_record could not resolve its statements");
  const { stop, failures } = await settleBatch(
    ["historical_record", "company_genesis", "moat_analysis"],
    [{ status: "rejected", reason: failure }, { status: "fulfilled", value: valid },
      { status: "rejected", reason: new ResearchRequestsPending() }],
    async (stageKey) => { advanced.push(stageKey); return { success: true, action: "continue" }; },
    notes,
  );
  assert.deepEqual(advanced, ["company_genesis"]);
  assert.equal(stop, false);
  assert.deepEqual(failures, [{ stageKey: "historical_record", reason: failure }]);
  assert.equal(notes.length, 2, "the advance and the paused request are both noted");
});

test("only provider and stream failures count as transient agent errors", () => {
  for (const type of ["server_error", "rate_limit", "provider_timeout", "connection", "malformed_stream", "output_exhausted"]) {
    assert.equal(isTransientAgentError(agentError(type)), true, type);
  }
  for (const type of ["schema_validation", "quota_exceeded", "authentication", "invalid_request", "cancellation"]) {
    assert.equal(isTransientAgentError(agentError(type)), false, type);
  }
  assert.equal(isTransientAgentError(new Error("wrapped", { cause: agentError("server_error") })), true);
  assert.equal(isTransientAgentError(new Error("Invalid company_genesis")), false);
});

test("the worker poll loop survives failing polls with a growing delay", async () => {
  const controller = new AbortController();
  const logged: string[] = [];
  let calls = 0;
  await pollUntilStopped(async () => {
    calls += 1;
    if (calls <= 2) throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
    controller.abort();
    return false;
  }, { pollIntervalMs: 1, errorDelayMs: 1, signal: controller.signal, log: (message) => logged.push(message) });
  assert.equal(calls, 3);
  assert.deepEqual(logged.map((message) => /retrying in (\d+) ms/.exec(message)?.[1]), ["1", "2"]);
});

test("--once runs a single step and reports its failure", async () => {
  let calls = 0;
  await pollUntilStopped(async () => { calls += 1; return true; }, { once: true, pollIntervalMs: 1, signal: new AbortController().signal });
  assert.equal(calls, 1);
  await assert.rejects(pollUntilStopped(async () => { throw new Error("down"); }, { once: true, pollIntervalMs: 1, signal: new AbortController().signal }), /down/);
});

test("job completion writes are retried before giving up", async () => {
  let calls = 0;
  assert.equal(await withRetries(async () => { calls += 1; if (calls === 1) throw new Error("blip"); return "ok"; }, 3, 1), "ok");
  assert.equal(calls, 2);
  await assert.rejects(withRetries(async () => { throw new Error("still down"); }, 2, 1), /still down/);
});
