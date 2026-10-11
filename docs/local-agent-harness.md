# Research OS local agent harness

Research OS calls configured inference endpoints directly. It does not start an OpenCode server or use the OpenCode SDK, localhost sidecar, session database, or history API.

For an OpenCode Go subscription, `opencode-go-direct` calls the published HTTPS inference API without the OpenCode SDK or localhost server. Each provider instance sends an `x-opencode-session` ID and identifies itself as `research-os/0.1`. It routes GLM, Kimi, and DeepSeek models through `/chat/completions`, and Qwen or MiniMax models through `/messages` according to the provider's published protocol table.

```dotenv
RESEARCH_MODEL_PROVIDER=opencode-go-direct
RESEARCH_MODEL_BASE_URL=https://opencode.ai/zen/go/v1
RESEARCH_MODEL_API_KEY=replace-locally
RESEARCH_MODEL_ALLOWED_HOSTS=opencode.ai
```

## Anthropic API

`anthropic-direct` calls the Anthropic Messages API (`/v1/messages`) with `x-api-key` and `anthropic-version: 2023-06-01`. It reads `RESEARCH_MODEL_API_KEY`, then `ANTHROPIC_API_KEY`. Claude models get no `temperature`, because current Claude models reject non-default sampling values.

```dotenv
RESEARCH_MODEL_PROVIDER=anthropic-direct
RESEARCH_MODEL_BASE_URL=https://api.anthropic.com/v1
RESEARCH_MODEL_ALLOWED_HOSTS=api.anthropic.com
ANTHROPIC_API_KEY=replace-locally
RESEARCH_ALL_AGENTS_MODEL=claude-haiku-5-5
```

### Prompt caching

`src/lib/agent-harness/providers/anthropic-cache.ts` places every `cache_control` breakpoint ([Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)). Claude models get two of the four allowed breakpoints:

1. the system block, which holds the agent's instructions;
2. the end of the task prompt. A transport retry, fallback or schema repair resends that prompt as an identical block, so it reads from cache. A repair's own instructions follow in a separate block that isn't cached.

Other models on the Anthropic protocol (Qwen and MiniMax on OpenCode Go) keep only the system breakpoint. Prompts shorter than the model minimum (512 tokens for Claude 5.5 models) are processed uncached without an error.

| Variable | Default | Effect |
| --- | --- | --- |
| `RESEARCH_ANTHROPIC_CACHE_CONTROL` | on | `0` sends no `cache_control`, for endpoints that reject it. |
| `RESEARCH_ANTHROPIC_CACHE_PROMPT` | on | `0` keeps only the system breakpoint for Claude models. |
| `RESEARCH_ANTHROPIC_CACHE_TTL` | `5m` | `1h` keeps entries for an hour, applied to Claude breakpoints only. |

Cost: a 5-minute write costs 1.25x input and a 1-hour write costs 2x; a read costs 0.1x on Haiku 5.5 (0.05x on Opus and Sonnet 5.5). The prompt breakpoint writes the whole packet on every call, so it pays off once more than about 28% of calls resend it. In two Haiku 5.5 runs, 15 of 59 calls needed a repair; retries and fallbacks add to that. Set `RESEARCH_ANTHROPIC_CACHE_PROMPT=0` if repairs become rare. The cost ledger prices 1-hour writes at 2x from the `cache_creation` usage breakdown.

### Structured output

For Claude models, `anthropic-direct` sends the task's output schema as `output_config.format` ([Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)), so the model can't return the wrong shape. `src/lib/agent-harness/providers/anthropic-schema.ts` converts the contract's JSON schema to the subset the API accepts: every object is closed, and length, range, `pattern`, `maxItems` and `minItems` above 1 are dropped. The runner still parses, validates against the full zod contract and repairs as before, so dropped constraints are still enforced.

A schema stays plain text when it can't be expressed: open objects or records (`additionalProperties` that isn't `false`, `propertyNames`), recursive `$ref`, more than 24 optional properties or more than 16 union-typed schemas. Today that covers the valuation, operating-scenario and reviewer contracts and every registry default schema. If the API rejects a schema with a 400 (for example "Schema is too complex for compilation"), the provider resends the request once without `output_config` and doesn't send that schema again until the process restarts. Each pass records `structuredOutput: { sent, fallback }` under `model_call_logs.response_metadata_json.provider_requests[]`.

OpenCode Go (including Qwen and MiniMax on `/messages`), OpenAI-compatible providers and the mock never send `output_config`.

| Variable | Default | Effect |
| --- | --- | --- |
| `RESEARCH_ANTHROPIC_STRUCTURED_OUTPUT` | on | `0` sends plain-text requests, as before this feature. Read when the provider is created. |

Changing the schema invalidates the prompt cache, because the API adds a schema-specific system prompt. Generation and repair of one task send the same schema, so the repair still reads the task prompt from cache.

## Direct HTTPS provider

Set these values in `.env.local` without committing credentials:

```dotenv
RESEARCH_MODEL_PROVIDER=direct-openai-compatible
RESEARCH_MODEL_BASE_URL=https://provider.example/v1
RESEARCH_MODEL_API_KEY=replace-locally
RESEARCH_MODEL_ALLOWED_HOSTS=provider.example
RESEARCH_CHEAP_MODEL=provider-model-id
RESEARCH_MID_MODEL=provider-model-id
RESEARCH_ASSET_ANALYST_MODEL=provider-model-id
RESEARCH_VALUATION_ANALYST_MODEL=provider-model-id
```

The base URL must use HTTPS and its exact hostname must appear in `RESEARCH_MODEL_ALLOWED_HOSTS`. Redirects and arbitrary per-request URLs are not supported.

Run the deliberately gated health and JSON smoke test with:

```bash
RUN_PROVIDER_SMOKE=1 npm run test:provider-smoke
```

The smoke request carries a small output schema. `outputConfigSent` in its output has one entry per request sent, so on `anthropic-direct` it shows whether `output_config` was sent (`[true]`) and whether the schema fallback fired (`[true, false]`).

After changing source batching, prompts, or deadlines, run the bounded source-reader smoke before a complete paid research run:

```bash
RUN_SOURCE_READER_SMOKE=1 npm run test:source-reader-smoke
```

## Local OpenAI-compatible or Ollama endpoint

Use an endpoint bound to loopback or a configured private address. API keys are optional for local mode.

```dotenv
RESEARCH_MODEL_PROVIDER=local-openai-compatible
RESEARCH_MODEL_BASE_URL=http://127.0.0.1:11434/v1
RESEARCH_MODEL_API_KEY=
RESEARCH_CHEAP_MODEL=local-model-id
RESEARCH_MID_MODEL=local-model-id
```

Ollama's OpenAI-compatible endpoint uses the `/v1` base path. The configured model IDs must already exist on the local server.

## Execution controls

The harness requests plain text, parses JSON locally, and performs at most one bounded repair by default. On `anthropic-direct`, Claude output is constrained to the contract schema where the API can express it ([structured output](#structured-output)); local parsing, validation and repair still apply. Total and inactivity deadlines, response/token limits, and model attempts use the `RESEARCH_*` settings documented in `.env.example`. Model calls cannot execute tools; an unexpected tool request fails the attempt. On the Anthropic protocol, pings and hidden adaptive-thinking events count as stream activity, so the inactivity deadline measures real provider silence rather than time to the first answer text.

Retries:

- Rate limits, timeouts, dropped connections, malformed streams, exhausted output and server errors are retried, and the next attempt may go to the agent's fallback model. Server errors include HTTP 5xx, Anthropic's 529 and its mid-stream `overloaded_error` and `api_error` events, and OpenCode's 400 "Upstream request failed". A mid-stream `rate_limit_error` counts as a rate limit.
- Server errors and rate limits wait `RESEARCH_OVERLOAD_RETRY_DELAY_MS` (5 s) before the second attempt, doubling after that; other retries wait `RESEARCH_RETRY_BASE_DELAY_MS`, doubling. A `retry-after` header sets the wait instead. Waits are capped at 60 s and end early when the run is aborted.
- A reply cut off at its output limit (`max_tokens` or `length`) that doesn't parse isn't repaired: the next attempt regenerates with twice the limit. Claude models are capped at 128,000 output tokens (64,000 for Claude Haiku 4.5).
- Authentication, quota, invalid requests, context limits and schema failures after repair aren't retried.
- The built-in fallback models (`deepseek-v4-pro`, `qwen3.7-plus`) are OpenCode Go model IDs, so `anthropic-direct` doesn't use them. A `RESEARCH_<AGENT>_FALLBACK_MODEL` you set still applies.

When a stage fails because a model call used up its attempts on one of these transient errors, the pipeline retries the stage itself ([system.md](system.md#run-failures-recovery-and-cancellation)).

Analytical stages derive their prompt schemas and runtime checks from the artifact Zod contracts. Invalid model output enters repair before a task is marked complete. The artifact repository checks those contracts again before saving validated or accepted content.

Completed tasks are reused only when the request fingerprint matches: packet, prompt, output contract, agent, model, provider endpoint, and version fields. Reuse revalidates the stored output. Failed stage validation invalidates that stage's cached tasks so a retry generates new output.

Source-reader extraction is partitioned in retrieval order into stable `source-reader:batch:NN` tasks. Each batch is bounded by both chunk count and serialized bytes, so completed batches can be reused after a later batch fails. The merge rejects invented source/chunk identifiers and invalid character ranges before evidence is persisted. A fallback receives only the failed batch with shortened excerpts; it never receives the complete research corpus.

Source-reader requests cap output at 16,384 tokens by default. Other agents cap output at 32,768 tokens. The source-reader deadline is ten minutes, with batches bounded at eight chunks and 36,000 serialized bytes. Set `RESEARCH_ALL_AGENTS_MODEL=deepseek-v4.1-flash` to route every agent to that model during a run.

Anthropic-compatible `/messages` requests (used by Qwen and MiniMax on OpenCode Go) require `max_tokens`; Research OS sends the agent's output ceiling, with `RESEARCH_ANTHROPIC_PROTOCOL_MAX_TOKENS` as a protocol fallback.

Provider credentials, authorization headers, and bounded raw-response excerpts are redacted before errors or attempt traces are persisted.
