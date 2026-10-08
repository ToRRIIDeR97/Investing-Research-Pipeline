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

The harness requests plain text, parses JSON locally, and performs at most one bounded repair by default. Total and inactivity deadlines, response/token limits, and model attempts use the `RESEARCH_*` settings documented in `.env.example`. Model calls cannot execute tools; an unexpected tool request fails the attempt.

Analytical stages derive their prompt schemas and runtime checks from the artifact Zod contracts. Invalid model output enters repair before a task is marked complete. The artifact repository checks those contracts again before saving validated or accepted content.

Completed tasks are reused only when the request fingerprint matches: packet, prompt, output contract, agent, model, provider endpoint, and version fields. Reuse revalidates the stored output. Failed stage validation invalidates that stage's cached tasks so a retry generates new output.

Source-reader extraction is partitioned in retrieval order into stable `source-reader:batch:NN` tasks. Each batch is bounded by both chunk count and serialized bytes, so completed batches can be reused after a later batch fails. The merge rejects invented source/chunk identifiers and invalid character ranges before evidence is persisted. A fallback receives only the failed batch with shortened excerpts; it never receives the complete research corpus.

Source-reader requests cap output at 16,384 tokens by default. Other agents cap output at 32,768 tokens. The source-reader deadline is ten minutes, with batches bounded at eight chunks and 36,000 serialized bytes. Set `RESEARCH_ALL_AGENTS_MODEL=deepseek-v4.1-flash` to route every agent to that model during a run.

Anthropic-compatible `/messages` requests (used by Qwen and MiniMax on OpenCode Go) require `max_tokens`; Research OS sends the agent's output ceiling, with `RESEARCH_ANTHROPIC_PROTOCOL_MAX_TOKENS` as a protocol fallback.

Provider credentials, authorization headers, and bounded raw-response excerpts are redacted before errors or attempt traces are persisted.
