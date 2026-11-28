import { NextRequest } from "next/server";
import { ApiError, handleApiError, successResponse } from "@/lib/api/errors";

/**
 * GET /api/settings/models — the Settings page's provider and model choices (secrets as set/last-4 only), plus the
 * values the server started with from its env files, so the page can show what applies when a field is left empty.
 * PUT { set: {KEY: value}, clear: [KEY] } — validates, writes .env.settings.local, applies to this server process.
 * The research worker picks the file up before its next job.
 */
/**
 * What each `latest:<family>` alias in use resolves to with the provider in effect, e.g.
 * { "latest:haiku": { model: "claude-haiku-5-5" } }. Uses the worker's one-hour model-list cache; never throws.
 */
async function latestModels(): Promise<Record<string, { model: string | null; error?: string }>> {
  const m = await import("@/lib/settings/model-settings");
  const { isLatestAlias } = await import("@/lib/agent-harness/model-family");
  await m.refreshProcessSettings();
  const aliases = new Set(Object.entries(process.env)
    .filter(([k, v]) => /_MODEL$/.test(k) && m.isAllowedSettingKey(k) && isLatestAlias(v))
    .map(([, v]) => v!.trim()));
  if (!aliases.size) return {};
  const out: Record<string, { model: string | null; error?: string }> = {};
  try {
    const { getProvider } = await import("@/lib/agent-harness/providers/provider");
    const { resolveModel } = await import("@/lib/agent-harness/latest-model");
    const provider = getProvider();
    for (const alias of aliases) {
      try { out[alias] = { model: await resolveModel(alias, provider) }; }
      catch (error) { out[alias] = { model: null, error: error instanceof Error ? error.message : String(error) }; }
    }
  } catch (error) {
    for (const alias of aliases) out[alias] = { model: null, error: error instanceof Error ? error.message : String(error) };
  }
  return out;
}

async function view() {
  const m = await import("@/lib/settings/model-settings");
  const { RESEARCH_AGENT_NAMES } = await import("@/lib/agent-harness/registry");
  const saved = await m.readSettings();
  const fromEnv: Record<string, string> = {};
  const startup = m.startupEnv();
  for (const [k, v] of Object.entries(startup)) if (v && m.isAllowedSettingKey(k) && !m.isSecretKey(k)) fromEnv[k] = v;
  const envSecrets: Record<string, boolean> = {};
  for (const k of m.SECRET_KEYS) envSecrets[k] = !!startup[k];
  return {
    ...m.publicSettings(saved), env: fromEnv, env_secrets: envSecrets, ignored: m.settingsIgnored(), latest: await latestModels(),
    provider_types: m.PROVIDER_TYPES, efforts: m.EFFORT_VALUES, agents: RESEARCH_AGENT_NAMES, file: m.SETTINGS_FILE,
  };
}

export async function GET() {
  try { return successResponse(await view()); } catch (error) { return handleApiError(error); }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") throw new ApiError("Send { set, clear }.", 400, "INVALID_SETTINGS");
    const m = await import("@/lib/settings/model-settings");
    const problems = m.validateSettingChanges(body.set ?? {}, body.clear ?? []);
    if (problems.length) throw new ApiError(problems.join(" "), 400, "INVALID_SETTINGS");
    const next = { ...(await m.readSettings()) };
    for (const key of Array.isArray(body.clear) ? body.clear : []) if (typeof key === "string") delete next[key];
    Object.assign(next, m.sanitizeSettings(body.set ?? {}));
    await m.writeSettings(next);
    await m.refreshProcessSettings();
    return successResponse(await view());
  } catch (error) {
    return handleApiError(error);
  }
}
