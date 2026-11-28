/**
 * Model and provider settings chosen in the app (Settings page), kept in the gitignored `.env.settings.local` beside
 * `.env.local`, as KEY=value lines. Only whitelisted keys are accepted: the provider (`RESEARCH_MODEL_*`), saved
 * providers (`PRAGMA_PROVIDER_<n>_*`, one active via `PRAGMA_ACTIVE_PROVIDER`), and models and efforts per tier and
 * agent. API keys are write-only: `publicSettings` reports only whether one is set and its last four characters.
 * The worker applies the file before each job (`applySettingsToEnv`), so a change takes effect on the next run
 * without a restart; a key removed from the file falls back to the value the process started with.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { RESEARCH_AGENT_NAMES } from "@/lib/agent-harness/registry";

export const SETTINGS_FILE = ".env.settings.local";

export const PROVIDER_TYPES = ["opencode-go-direct", "anthropic-direct", "direct-openai-compatible", "local-openai-compatible", "mock"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];
export const MAX_SAVED_PROVIDERS = 8;
export const EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"] as const;

const agentKey = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
const TIERS = ["CHEAP", "MID", "PREMIUM"];

/** Keys whose values are secrets. */
export const SECRET_KEYS = new Set(["RESEARCH_MODEL_API_KEY", "OPENCODE_GO_API_KEY", "ANTHROPIC_API_KEY"]);
const SAVED = /^PRAGMA_PROVIDER_([1-8])_(LABEL|TYPE|BASE_URL|ALLOWED_HOSTS|API_KEY)$/;

const ALLOWED = new Set<string>([
  "RESEARCH_MODEL_PROVIDER", "RESEARCH_MODEL_BASE_URL", "RESEARCH_MODEL_ALLOWED_HOSTS", "OPENCODE_BASE_URL",
  ...SECRET_KEYS,
  "RESEARCH_ALL_AGENTS_MODEL", "RESEARCH_VISION_MODEL", "RESEARCH_EFFORT", "PRAGMA_ACTIVE_PROVIDER",
  ...TIERS.flatMap((t) => [`RESEARCH_${t}_MODEL`, `RESEARCH_${t}_EFFORT`, `RESEARCH_${t}_FALLBACK_MODEL`]),
  ...RESEARCH_AGENT_NAMES.flatMap((n) => [`RESEARCH_${agentKey(n)}_MODEL`, `RESEARCH_${agentKey(n)}_FALLBACK_MODEL`]),
]);

export function isAllowedSettingKey(key: string): boolean {
  return ALLOWED.has(key) || SAVED.test(key);
}
export function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key) || /_API_KEY$/.test(key);
}

export type Settings = Record<string, string>;

/** Whitelisted keys with single-line values of at most 500 characters; anything else is dropped. Pure. */
export function sanitizeSettings(input: unknown): Settings {
  const out: Settings = {};
  if (!input || typeof input !== "object") return out;
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!isAllowedSettingKey(key) || typeof raw !== "string") continue;
    if (/[\u0000-\u001f\u007f]/.test(raw)) continue;
    const value = raw.trim();
    if (!value || value.length > 500) continue;
    out[key] = value;
  }
  return out;
}

/** What the page may see: every non-secret value, and for secrets only whether one is set and its last 4. Pure. */
export function publicSettings(settings: Settings): { values: Settings; secrets: Record<string, { set: boolean; last4: string | null }> } {
  const values: Settings = {}, secrets: Record<string, { set: boolean; last4: string | null }> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (isSecretKey(key)) secrets[key] = { set: true, last4: value.length >= 8 ? value.slice(-4) : null };
    else values[key] = value;
  }
  return { values, secrets };
}

/** Problems with a requested change, as sentences (empty when it is valid). Pure. */
export function validateSettingChanges(set: unknown, clear: unknown): string[] {
  const problems: string[] = [];
  if (!set || typeof set !== "object" || Array.isArray(set)) return ["`set` must be an object of settings."];
  if (!Array.isArray(clear)) return ["`clear` must be a list of setting names."];
  for (const key of clear) if (typeof key !== "string" || !isAllowedSettingKey(key)) problems.push(`${String(key)} is not a setting.`);
  for (const [key, raw] of Object.entries(set as Record<string, unknown>)) {
    if (!isAllowedSettingKey(key)) { problems.push(`${key} is not a setting.`); continue; }
    if (typeof raw !== "string" || !raw.trim() || raw.length > 500 || /[\u0000-\u001f\u007f]/.test(raw)) { problems.push(`${key} needs a single-line value of at most 500 characters.`); continue; }
    const value = raw.trim();
    if ((key === "RESEARCH_MODEL_PROVIDER" || /_TYPE$/.test(key)) && !(PROVIDER_TYPES as readonly string[]).includes(value)) problems.push(`${value} is not a provider type (${PROVIDER_TYPES.join(", ")}).`);
    if (/BASE_URL$/.test(key)) {
      try { const u = new URL(value); if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(); }
      catch { problems.push(`${key} must be an http or https address.`); }
    }
    if (/_EFFORT$/.test(key) && !(EFFORT_VALUES as readonly string[]).includes(value)) problems.push(`${key} must be one of ${EFFORT_VALUES.join(", ")}.`);
    if (key === "PRAGMA_ACTIVE_PROVIDER" && !/^[1-8]$/.test(value)) problems.push("PRAGMA_ACTIVE_PROVIDER must be a saved provider number, 1 to 8.");
    if (/ALLOWED_HOSTS$/.test(key) && !value.split(",").every((h) => /^[a-z0-9.-]+(:\d+)?$/i.test(h.trim()))) problems.push(`${key} must be a comma-separated list of host names.`);
  }
  return problems;
}

/** process.env as the module first saw it (after env files, before settings), for "from .env" hints. */
const STARTUP: Record<string, string | undefined> = { ...process.env };
export const startupEnv = () => STARTUP;

/** KEY=value lines, sorted, with a header. Values are single-line (sanitized), so no quoting is needed. Pure. */
export function serializeSettings(settings: Settings): string {
  const lines = Object.keys(settings).sort().map((k) => `${k}=${settings[k]}`);
  return `# Written by the Settings page. Gitignored; holds provider keys. Edit in the app or by hand.\n${lines.join("\n")}\n`;
}

/** Parses the file (KEY=value lines; # comments), keeping only valid settings. Pure. */
export function parseSettingsFile(text: string): Settings {
  const raw: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const at = t.indexOf("=");
    if (at <= 0) continue;
    raw[t.slice(0, at).trim()] = t.slice(at + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return sanitizeSettings(raw);
}

/**
 * The environment the settings imply: the keys as written, plus the active saved provider's type, base URL, allowed
 * hosts and key as `RESEARCH_MODEL_*` (explicit `RESEARCH_MODEL_*` keys win). Pure.
 */
export function effectiveEnv(settings: Settings): Settings {
  const env: Settings = {};
  for (const [k, v] of Object.entries(settings)) if (!SAVED.test(k) && k !== "PRAGMA_ACTIVE_PROVIDER") env[k] = v;
  const slot = settings.PRAGMA_ACTIVE_PROVIDER;
  if (slot && /^[1-8]$/.test(slot)) {
    const p = (f: string) => settings[`PRAGMA_PROVIDER_${slot}_${f}`];
    const pairs: [string, string | undefined][] = [["RESEARCH_MODEL_PROVIDER", p("TYPE")], ["RESEARCH_MODEL_BASE_URL", p("BASE_URL")],
      ["RESEARCH_MODEL_ALLOWED_HOSTS", p("ALLOWED_HOSTS")], ["RESEARCH_MODEL_API_KEY", p("API_KEY")]];
    for (const [k, v] of pairs) if (v && !(k in env)) env[k] = v;
  }
  return env;
}

/** The value each touched key had before the settings were first applied (undefined = unset). */
export type EnvRestore = Map<string, string | undefined>;

/**
 * Applies settings to `env` (process.env by default). Keys the settings set override; keys a previous call set but
 * these settings no longer do go back to their original value. Pass the returned map to the next call.
 */
export function applySettingsToEnv(settings: Settings, env: Record<string, string | undefined> = process.env, restore: EnvRestore = new Map()): EnvRestore {
  const next = effectiveEnv(settings);
  for (const [key, original] of restore) {
    if (key in next) continue;
    if (original === undefined) delete env[key]; else env[key] = original;
    restore.delete(key);
  }
  for (const [key, value] of Object.entries(next)) {
    if (!restore.has(key)) restore.set(key, env[key]);
    env[key] = value;
  }
  return restore;
}

export function settingsPath(projectRoot = process.cwd()): string {
  return resolve(projectRoot, SETTINGS_FILE);
}

export async function readSettings(projectRoot = process.cwd()): Promise<Settings> {
  try { return parseSettingsFile(await readFile(settingsPath(projectRoot), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {}; throw error; }
}

/** Writes the whole file atomically (temporary file, then rename). */
export async function writeSettings(settings: Settings, projectRoot = process.cwd()): Promise<void> {
  const path = settingsPath(projectRoot);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, serializeSettings(sanitizeSettings(settings)), { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

/**
 * A process that started on the mock provider (test suites, `npm run test:db`) or with PRAGMA_IGNORE_SETTINGS=1
 * never takes the file's settings, so a saved real provider can't turn a free test run into a paid one.
 */
const IGNORED = process.env.RESEARCH_MODEL_PROVIDER === "mock" || process.env.PRAGMA_IGNORE_SETTINGS === "1";
export const settingsIgnored = () => IGNORED;

let workerRestore: EnvRestore = new Map();
/** Reads the settings file and applies it to process.env (the worker calls this before each job). Never throws. */
export async function refreshProcessSettings(projectRoot = process.cwd()): Promise<{ applied: number; error?: string }> {
  if (IGNORED) return { applied: 0 };
  try {
    const settings = await readSettings(projectRoot);
    workerRestore = applySettingsToEnv(settings, process.env, workerRestore);
    return { applied: Object.keys(effectiveEnv(settings)).length };
  } catch (error) {
    return { applied: 0, error: error instanceof Error ? error.message : String(error) };
  }
}
