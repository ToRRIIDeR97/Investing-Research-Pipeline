# Research OS local agent harness

Research OS calls configured inference endpoints directly. It does not start an OpenCode server or use the OpenCode SDK, localhost sidecar, session database, or history API.

For an OpenCode Go subscription, `opencode-go-direct` calls the published HTTPS inference API without the OpenCode SDK, localhost server, or session/history layer. It routes GLM, Kimi, and DeepSeek models through `/chat/completions`, and Qwen or MiniMax models through `/messages` according to the provider's published protocol table.

```dotenv
RESEARCH_MODEL_PROVIDER=opencode-go-direct
RESEARCH_MODEL_BASE_URL=https://opencode.ai/zen/go/v1
RESEARCH_MODEL_API_KEY=
RESEARCH_MODEL_ALLOWED_HOSTS=opencode.ai
```

The harness sends the explicit `RESEARCH_MODEL_API_KEY` (or `OPENCODE_GO_API_KEY`) as a bearer token; it does not read OpenCode's local credential store.

## Model resolution

Every agent resolves its primary model from environment variables at call time:

1. `RESEARCH_<AGENT_NAME>_MODEL` when present;
2. the agent's configured tier/specialist variable such as `RESEARCH_CHEAP_MODEL`, `RESEARCH_MID_MODEL`, or `RESEARCH_ASSET_ANALYST_MODEL`;
3. `RESEARCH_DEFAULT_MODEL`, whose safe default is `deepseek-v4-flash`.

Retries use `RESEARCH_<AGENT_NAME>_FALLBACK_MODEL`, then `RESEARCH_FALLBACK_MODEL`, then the same DeepSeek V4 Flash default. Registry defaults never select a premium, vision, or coding model implicitly. Historical model-call rows retain the model actually used at execution time and are not rewritten when `.env.local` changes.

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

The harness requests plain text, parses JSON locally, and performs at most one bounded repair by default. Total and inactivity deadlines, response/token limits, model attempts, tool turns, and tool calls use the `RESEARCH_*` settings documented in `.env.example`. Research agents have no tool permissions unless a tool is explicitly registered and allowed by that agent's definition.

Source-reader extraction is partitioned in retrieval order into stable `source-reader:batch:NN` tasks. Each batch is bounded by both chunk count and serialized bytes, so completed batches can be reused after a later batch fails. The merge rejects invented source/chunk identifiers and invalid character ranges before evidence is persisted. A fallback receives only the failed batch with shortened excerpts; it never receives the complete research corpus.

Model requests sharing one configured provider endpoint are serialized at the provider boundary, even when stage workers are preparing independent tasks. If one source-reader request fails, its sibling requests are cancelled before the stage exits, so queued calls cannot continue charging after a failed run.

Source-reader model attempts omit `max_tokens` on OpenAI-compatible requests because reasoning is included in that provider field and a low ceiling can suppress the final JSON. Source-reader calls use a 20-minute total and 10-minute inactivity deadline; batches remain bounded at four chunks and 16,000 serialized bytes to keep reasoning packets responsive. The response-byte safety bound and the run's dollar budget remain enforced.

Anthropic-compatible `/messages` requests (used by Qwen and MiniMax on OpenCode Go) require `max_tokens`; Research OS supplies the high protocol value in `RESEARCH_ANTHROPIC_PROTOCOL_MAX_TOKENS` instead of treating it as an agent policy ceiling. Set a positive `RESEARCH_MAX_OUTPUT_TOKENS` or agent-specific `RESEARCH_*_MAX_OUTPUT_TOKENS` later to restore an explicit harness ceiling.

Provider credentials, authorization headers, and bounded raw-response excerpts are redacted before errors or attempt traces are persisted.
