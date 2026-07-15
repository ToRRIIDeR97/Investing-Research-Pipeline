# Research OS local agent harness

Research OS calls OpenAI-compatible inference endpoints directly. It does not start or connect to an OpenCode server, gateway, sidecar, or session service.

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

Provider credentials, authorization headers, and bounded raw-response excerpts are redacted before errors or attempt traces are persisted.
