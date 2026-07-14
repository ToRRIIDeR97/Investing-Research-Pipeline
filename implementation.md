# Research OS Local Agent Harness Migration Plan

## Mission

Replace the current OpenCode operational dependency with a Research OS-owned agent harness embedded in this repository.

The intended architecture is:

```text
Research workflow
  -> Research OS agent runner
  -> embedded local harness
  -> direct remote-provider adapter or local-inference adapter
  -> streamed model events
  -> local JSON extraction and schema validation
  -> Research OS persistence and quality gates
```

“Local harness” means the execution loop, streaming, retries, cancellation, validation, tools, traces, and usage accounting run inside Research OS. It does not imply that model inference is local. A direct GLM/Qwen/OpenAI-compatible API remains remote; an Ollama, llama.cpp, MLX, or vLLM adapter would provide genuinely local inference.

The migration must preserve all Research v2 reliability work already present on this branch. Do not weaken evidence provenance, metric reconciliation, required-module validation, budget controls, valuation preflight, fail-closed workflow behavior, or human-review integrity.

## Branch and baseline

- Working branch: `codex/local-agent-harness`.
- Baseline commit: `0375ea7d` from `research-os-v2-test`.
- Read first:
  - `handover files/2026-07-14-research-os-local-harness-transition-handover.md`
  - `handover files/2026-07-14-meli-deep-dive-reliability-handover.md`
  - `src/lib/opencode/runtime.ts`
  - `src/lib/opencode/agent-registry.ts`
  - `src/lib/agents/model-calls.ts`
  - `src/lib/research/system-pipeline.ts`

Before editing, run and record:

```bash
git status --short
npm run test:unit
npx tsc --noEmit
npm run build
```

The expected baseline is 16 passing Node unit tests, clean TypeScript, and a successful Next.js build.

## Architectural boundaries

Research OS must own:

- Agent definitions and prompt versions
- Model/provider selection policy
- Streaming and cancellation
- Total and inactivity deadlines
- Retry, repair, and fallback decisions
- JSON extraction and schema validation
- Tool registration and authorization
- Token, cost, latency, and attempt accounting
- Raw-response/trace persistence
- Workflow/task state transitions
- Research evidence and human-review contracts

Provider adapters must own only:

- Authentication headers
- Provider request translation
- Provider streaming/event translation
- Provider error normalization
- Provider usage/cost fields when available

Domain and workflow code must never depend on provider-specific response objects.

## Explicit non-goals

Do not vendor or reproduce the full OpenCode CLI. Exclude:

- Terminal UI and command routing
- Coding-agent patch/edit behavior
- OpenCode workspace and project discovery
- OpenCode session database
- OpenCode HTTP server
- `opencode-go` hosted gateway authentication
- Native OpenCode structured-output handling
- General-purpose shell/tool permissions unrelated to research
- OpenCode-specific message/history schemas

Do not claim local inference unless a configured adapter actually targets a local model server.

## Phase 1: OpenCode source and license audit

The user explicitly wants to adapt useful harness parts from the open-source OpenCode CLI.

1. Identify the exact upstream repository, release, and commit corresponding to the code being studied.
2. Read the repository license and any third-party notices before copying code.
3. Create a short provenance document, for example `docs/open-source-provenance.md`, containing:
   - Repository URL
   - Commit SHA
   - License identifier
   - Files or algorithms studied/adapted
   - Whether each local file is copied, modified, or independently reimplemented
   - Required attribution and notice placement
4. Prefer reimplementing small protocol-independent patterns behind Research OS interfaces. Copy source only where it materially reduces risk and the license permits it.
5. Preserve required copyright headers in adapted files.
6. Do not import OpenCode internals as a runtime package merely to avoid designing a stable boundary.

Stop and report a blocker if the license cannot be established or is incompatible with this repository’s intended use.

## Phase 2: Define the local harness contracts

Create a provider-neutral package under `src/lib/agent-harness/`. Suggested files:

```text
src/lib/agent-harness/
  types.ts
  errors.ts
  runner.ts
  deadlines.ts
  output-parser.ts
  validation.ts
  registry.ts
  tools.ts
  telemetry.ts
  providers/
    provider.ts
    openai-compatible.ts
    local-openai-compatible.ts
    mock.ts
```

Define stable contracts equivalent to the following concepts; exact names may vary:

```ts
type ModelEvent =
  | { type: "response.started"; requestId?: string }
  | { type: "text.delta"; text: string }
  | { type: "reasoning.delta"; text: string }
  | { type: "tool.call"; call: ToolCall }
  | { type: "usage"; usage: ModelUsage }
  | { type: "response.completed"; finishReason?: string }
  | { type: "response.failed"; error: ProviderError };

interface ModelProvider {
  readonly id: string;
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
  healthCheck?(): Promise<ProviderHealth>;
}

interface AgentHarness {
  run<T>(request: AgentRequest<T>): Promise<AgentResult<T>>;
}
```

Requirements:

- `AbortSignal` must propagate to the provider socket/request.
- Events must be provider-neutral and serializable.
- The result must contain parsed output, raw text, usage, provider/model, attempt history, timing, prompt version, and validation/repair metadata.
- Provider errors must normalize into explicit categories such as authentication, rate limit, connection, provider timeout, invalid request, context limit, cancellation, malformed stream, and unknown provider error.
- Secrets must never be included in events, errors, traces, or database metadata.

## Phase 3: Build direct provider adapters

Implement a generic OpenAI-compatible streaming adapter first. It should support a configurable base URL and model name without embedding workflow knowledge.

Configuration should use explicit environment variables such as:

```text
RESEARCH_MODEL_PROVIDER=openai-compatible
RESEARCH_MODEL_BASE_URL=
RESEARCH_MODEL_API_KEY=
RESEARCH_ASSET_ANALYST_MODEL=
RESEARCH_ASSET_ANALYST_FALLBACK_MODEL=
RESEARCH_VALUATION_ANALYST_MODEL=
```

Use provider-specific variables only when the protocol genuinely differs. Do not silently reuse `OPENCODE_GO_API_KEY`; direct-provider credentials must be deliberately configured and the exposed old key must be rotated.

Adapter requirements:

1. Stream response bytes/events rather than waiting for one large body.
2. Normalize text, reasoning, finish reason, request ID, and usage.
3. Handle partial frames and clean stream termination.
4. Convert HTTP status codes and provider error bodies into harness error categories.
5. Respect cancellation immediately.
6. Apply connection and response-body size limits.
7. Redact authorization headers and provider secrets.
8. Allow a local OpenAI-compatible endpoint through a separate configuration profile.
9. Validate configured base URLs and prevent user-controlled arbitrary URLs from becoming an SSRF path.

If GLM 5.2 and Qwen 3.7 Plus cannot both be accessed through the same direct protocol/account, implement the smallest additional adapter needed. Document the actual endpoint ownership: direct vendor, authorized gateway, or local inference. Do not describe a gateway as direct vendor access.

## Phase 4: Implement the execution engine

Move the reusable behavior currently concentrated in `src/lib/opencode/runtime.ts` into the local harness.

### Streaming and deadlines

- Support a total attempt deadline and an inactivity deadline.
- Reset the inactivity deadline whenever a valid response event arrives.
- Use an initial asset-analysis total deadline around 10 minutes and an inactivity deadline around 90 seconds; make both agent-specific and configurable.
- Abort the provider request on deadline or operator cancellation.
- Await cleanup sufficiently to avoid orphan requests.
- Record whether termination came from total timeout, inactivity timeout, provider failure, or operator cancellation.

### Output handling

- Request one plain JSON object in the prompt; do not depend on a provider’s native structured-output feature.
- Accumulate raw text with a configurable maximum size.
- Parse direct JSON and fenced JSON safely.
- Validate locally against the agent’s schema.
- Reject truncated or incomplete JSON.
- Never mark a task complete merely because text resembles JSON.
- Preserve a bounded raw-response artifact and validation errors for audit.

### Repair, retry, and fallback

- Permit at most one schema-repair prompt per model attempt unless an agent policy explicitly says otherwise.
- The repair prompt must contain the validation errors and a bounded prior response, not the entire original research corpus again.
- Retry only errors classified as retryable.
- Honor `Retry-After` and use capped jittered backoff for rate limits/transient provider failures.
- Fallback must be materially smaller: compact evidence, reduce reasoning, and request only unfinished modules.
- Do not retry authentication, invalid configuration, deterministic schema incompatibility, or operator cancellation.
- Track every attempt separately and aggregate actual total latency/cost correctly.

### Tools

- Implement a deny-by-default tool registry.
- Each agent definition must explicitly list permitted tools.
- Validate tool inputs locally before execution.
- Keep research tools narrow and read-only unless a workflow explicitly authorizes a write.
- Add loop and call-count limits so models cannot invoke tools indefinitely.
- Record tool calls and results with secret/content redaction.

The initial migration may run current agents without tools if they only need supplied research packets. Do not copy OpenCode’s general coding tools into this project.

## Phase 5: Adapt the agent registry

Refactor `src/lib/opencode/agent-registry.ts` into a provider-neutral Research OS registry, preferably under `src/lib/agent-harness/registry.ts` or `src/lib/agents/registry.ts`.

Each definition should contain:

- Agent name and purpose
- Prompt version
- Output schema
- Primary and fallback model routing keys
- Allowed tools
- Reasoning/effort preference expressed generically
- Total and inactivity deadlines
- Repair/retry limits
- Maximum response size
- Budget or token ceiling where available

Do not store provider credentials, concrete HTTP clients, or OpenCode types in the registry.

Preserve all existing agent output keys expected by `system-pipeline.ts` so the harness migration does not become a simultaneous domain-schema rewrite.

## Phase 6: Integrate without regressing the pipeline

1. Introduce a provider-neutral `runResearchAgent` replacement and switch `src/lib/research/system-pipeline.ts` to it.
2. Keep task and model-call persistence compatible with existing database tables where practical.
3. Extend model-call metadata to retain:
   - Provider/model
   - Attempt number
   - Direct provider request ID
   - Start/end/latency
   - Tokens and cost
   - Timeout/cancellation category
   - Repair/fallback/compaction status
   - Raw-response artifact reference or bounded excerpt
4. Ensure a failed model request transactionally closes its task/stage according to workflow policy.
5. Keep `asset_analysis` fail-closed for `deep_dive` and `full_initiation_report`.
6. Keep valuation blocked unless analysis and required modules complete.
7. Preserve the real human-review gate; never auto-create a human decision.
8. Preserve resumability and idempotency. A rerun must not duplicate accepted claims, metrics, source gaps, modules, or cost ledger entries.

During migration, an OpenCode compatibility adapter may exist temporarily behind the new `ModelProvider` interface, but direct/local adapters must be the default acceptance path. Do not let compatibility code leak into domain modules.

## Phase 7: Reduce monolithic research requests

The previous MELI asset-analysis request timed out because it attempted to produce every required module and long evidence arrays in one response.

Split asset analysis into bounded module groups, for example:

1. Business segments and competitive position
2. Commerce: revenue drivers, GMV, buyers, margins
3. Fintech: TPV, MAU, customer funds
4. Credit: loan book, provisions, losses, funding liabilities
5. Financial statements: FCF, capex, working capital, net debt, share count
6. Valuation inputs and unresolved gaps

Requirements:

- Send each group only relevant accepted evidence and canonical metrics.
- Require persisted evidence claim IDs for completed modules.
- Merge module outputs deterministically.
- Retry only failed/incomplete groups.
- Keep generic fallback prose from completing a required module.
- Reuse the retrieval and module-relevance helpers already present in `pipeline-helpers.ts`.

## Phase 8: Remove OpenCode operational dependencies

Only after direct/local harness parity tests pass:

1. Remove `@opencode-ai/sdk` from `package.json` and `package-lock.json`.
2. Remove `src/lib/opencode/runtime.ts` or leave a clearly isolated compatibility adapter only if explicitly required.
3. Rename/move remaining provider-neutral registry code out of `src/lib/opencode/`.
4. Remove `scripts/check-opencode.js` and the `predev`/`prebuild` hooks.
5. Remove `OPENCODE_BASE_URL`, `OPENCODE_GO_PROVIDER_ID`, `OPENCODE_GO_API_KEY`, and OpenCode-specific model variables from `.env.example`.
6. Remove sidecar startup instructions and replace them with harness/provider configuration documentation.
7. Confirm `opencode serve` is not needed for development, tests, build, worker operation, or a live research run.
8. Retain provenance/license notices required for any adapted OSS code.

Do not delete historical handovers; they document why the migration occurred.

## Automated test requirements

Use deterministic mock streams for most tests. No unit test may spend money or require a network connection.

### Provider adapter tests

- Parses fragmented streaming frames.
- Emits normalized text/reasoning/usage/completion events.
- Handles clean end-of-stream and malformed/truncated streams.
- Maps authentication, rate-limit, connection, context-limit, cancellation, and server errors.
- Honors `AbortSignal` and closes the underlying request.
- Redacts secrets from errors and traces.
- Rejects unsafe/unapproved base URLs.

### Deadline tests

- Total deadline aborts an endlessly active stream at the configured cap.
- Inactivity deadline aborts a silent stream.
- Incoming deltas reset only the inactivity deadline.
- Operator cancellation is not classified as provider timeout.
- Cleanup completes and no timer or request remains active.
- Tests use fake/injected clocks and complete quickly.

### Output and validation tests

- Accepts a valid JSON object.
- Accepts one valid fenced JSON object.
- Rejects truncated JSON.
- Rejects missing required keys and wrong value types.
- Does not select an unrelated example object when multiple objects appear.
- One valid repair succeeds.
- Repair exhaustion is terminal and fully recorded.
- Oversized output is bounded safely.

### Runner policy tests

- Primary success does not invoke fallback.
- Retryable primary failure invokes the configured fallback.
- Authentication/configuration failure does not retry.
- Fallback receives compacted context and only unfinished modules.
- Attempt metadata and aggregate usage/latency are accurate.
- Budget exhaustion prevents another attempt.
- Tool permission and call-count limits are enforced.

### Workflow integration tests

- Successful analysis advances to valuation.
- Failed required analysis does not create a valuation model call.
- Terminal runs leave no running task/stage.
- Resume is idempotent.
- Human review cannot be approved without a persisted approved human decision.
- Existing retrieval, metric reconciliation, source-gap, and valuation tests continue passing.

### Local integration tests

Create a test-only fake HTTP/SSE provider and exercise the real adapter over localhost. Cover success, slow streaming, inactivity, rate limiting, malformed frames, cancellation, and usage metadata.

Optionally run paid/provider smoke tests only behind an explicit command and environment flag, for example:

```bash
RUN_PROVIDER_SMOKE=1 npm run test:provider-smoke
```

Smoke tests must use tiny prompts, strict cost caps, and must never print credentials.

## Required verification commands

Run and report the exact results of:

```bash
npm run test:unit
npx tsc --noEmit
npm run build
git diff --check
```

Also run any new harness integration and provider-smoke commands added by the implementation. If `npm run lint` is unusable because of the installed Next.js tooling, report the exact failure instead of claiming lint passed.

Verify explicitly that:

```bash
rg -n "@opencode-ai/sdk|OPENCODE_GO|OPENCODE_BASE_URL|opencode serve" src scripts package.json .env.example
```

returns no active runtime dependency after cleanup, apart from intentional historical/provenance documentation.

## Final acceptance run: fresh MELI deep dive

After automated tests and direct-provider smoke tests pass, run a new MELI research round with `run_type: "deep_dive"`. Do not reuse run `76355c02-b88f-4b44-b65a-9af20896392d` or any earlier diagnostic run.

Research question:

> Separate MercadoLibre's commerce and fintech economics; evaluate revenue and margin drivers, credit growth and loss quality, working-capital and funding needs, country and currency risk, competitive position, and valuation under base, bull, and bear scenarios.

Use explicit UTC `Z` cutoffs. Set and report a sufficient but bounded budget. Approve the research-plan gate explicitly, but do not fabricate or automate the final human-review decision.

The acceptance run passes only when:

- It uses pipeline version 2.
- No OpenCode SDK, sidecar, `opencode-go` session, or OpenCode history API is used.
- Model calls are made through the Research OS local harness and configured direct/local adapters.
- Source evidence uses the latest completed parse and cites meaningful non-zero chunks.
- Claims link to persisted sources and chunks.
- Annual/quarterly MELI metric conflicts are resolved or explicitly surfaced.
- Every required MELI module completes with substantive module-specific evidence IDs.
- Asset analysis completes without monolithic-response timeout.
- Valuation starts only after analysis passes.
- Valuation scenarios contain numeric anchors or fail closed with an explicit engine/data gap.
- Model attempts record provider/model, request ID, tokens, cost, actual latency, repair/fallback state, and precise terminal category.
- No task or stage remains `running` after the request finishes or fails.
- The run remains within budget.
- Automation stops at genuine human review.

Report:

- New run ID
- Stage-by-stage status
- Provider/model and attempt durations
- Total cost
- Evidence claim/link/chunk counts
- Metric conflicts and canonical selections
- Required-module completion
- Valuation and scenario status
- Source gaps
- Backtest/reviewer status if reached
- Any remaining `needs_more_work` reason

## Completion checklist

- [ ] Baseline reliability tests remain green.
- [ ] OpenCode source/license provenance is documented.
- [ ] Provider-neutral local harness contracts exist.
- [ ] Direct OpenAI-compatible and deterministic mock adapters exist.
- [ ] Streaming, cancellation, total timeout, and inactivity timeout are tested.
- [ ] JSON extraction and schema validation are local and tested.
- [ ] Repair, fallback, compaction, budget, and telemetry policies are tested.
- [ ] Asset analysis is split into bounded module groups.
- [ ] Workflow remains fail-closed and resumable.
- [ ] OpenCode SDK, sidecar, gateway key flow, and startup checks are removed.
- [ ] Secrets are absent from logs, fixtures, commits, and handovers.
- [ ] TypeScript, unit tests, integration tests, build, and diff checks pass.
- [ ] A fresh MELI deep dive completes to a legitimate human-review checkpoint or produces a correct, explicit terminal failure.
- [ ] Final results and remaining risks are added to a new dated handover.

