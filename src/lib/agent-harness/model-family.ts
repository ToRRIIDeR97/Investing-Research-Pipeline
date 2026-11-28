/**
 * Model families and `latest:<family>` aliases. Pure: no network, no env.
 *
 * A model ID splits into word tokens and version numbers: `claude-haiku-4-5-20251001` is words {claude, haiku} and
 * version [4, 5] (an 8-digit date is a snapshot stamp, not a version); `deepseek-v4.1-flash` is {deepseek, v, flash}
 * and [4, 1]; `qwen3.7-plus` is {qwen, plus} and [3, 7]. `latest:haiku` matches every ID whose words include
 * "haiku" and picks the newest: fewest words beyond the alias's (so `-preview` or `-vl` variants lose to the plain
 * model), then the highest version, then the newest `created` time, then the shortest ID.
 */

export interface ListedModel {
  id: string;
  /** Unix milliseconds, when the provider reports it. */
  created?: number;
}

const ALIAS = /^\s*latest\s*:\s*([a-z0-9][a-z0-9.\- ]{0,60})\s*$/i;
/** IDs taken from a provider's list are untrusted; anything else is ignored. */
export const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\-]{0,119}$/;
/** Single letters that only prefix a version (`v4`, `k2.7`) and carry no family meaning. */
const VERSION_PREFIXES = new Set(["v", "k"]);

/** The family words of a `latest:<family>` alias (lowercase), or null when `value` is not one. */
export function latestAliasWords(value: string | null | undefined): string[] | null {
  const match = ALIAS.exec(value || "");
  if (!match) return null;
  const words = modelTokens(match[1]).words;
  return words.length ? words : null;
}

export const isLatestAlias = (value: string | null | undefined) => latestAliasWords(value) !== null;

export function modelTokens(id: string): { words: string[]; version: number[] } {
  const parts = id.toLowerCase().split(/[^a-z0-9]+|(?<=[a-z])(?=[0-9])|(?<=[0-9])(?=[a-z])/).filter(Boolean);
  const words: string[] = [], version: number[] = [];
  for (const part of parts) {
    if (/^\d+$/.test(part)) { if (part.length !== 8) version.push(Number(part)); }
    else if (!VERSION_PREFIXES.has(part)) words.push(part);
  }
  return { words, version };
}

/**
 * A GET /models body as a model list: `{ data: [{ id, created_at }] }` (Anthropic, ISO time) or
 * `{ data: [{ id, created }] }` (OpenAI-compatible, Unix seconds). Unsafe or missing IDs are dropped.
 */
export function parseModelList(body: unknown): ListedModel[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: ListedModel[] = [];
  for (const item of data.slice(0, 2_000)) {
    const raw = item as { id?: unknown; created?: unknown; created_at?: unknown } | null;
    if (typeof raw?.id !== "string" || !SAFE_MODEL_ID.test(raw.id)) continue;
    const created = typeof raw.created === "number" && Number.isFinite(raw.created) ? raw.created * 1_000
      : typeof raw.created_at === "string" && Number.isFinite(Date.parse(raw.created_at)) ? Date.parse(raw.created_at) : undefined;
    out.push(created === undefined ? { id: raw.id } : { id: raw.id, created });
  }
  return out;
}

function compareVersions(a: number[], b: number[]) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

/** Words every family shares and that never distinguish one (`claude` in every Anthropic ID). */
const NEUTRAL_WORDS = new Set(["claude"]);

/**
 * The newest model in the alias's family, or null when none matches. `wanted` is the alias's words (from
 * latestAliasWords) or a model's own words, so the pricing table can find a model's closest known relative.
 */
export function pickLatest<T extends ListedModel>(wanted: string[], models: readonly T[]): T | null {
  let best: { model: T; extras: number; version: number[] } | null = null;
  for (const model of models) {
    if (!SAFE_MODEL_ID.test(model.id)) continue;
    const { words, version } = modelTokens(model.id);
    if (!wanted.every((word) => words.includes(word))) continue;
    const extras = words.filter((word) => !wanted.includes(word) && !NEUTRAL_WORDS.has(word)).length;
    const better = !best
      || extras < best.extras
      || (extras === best.extras && (compareVersions(version, best.version) > 0
        || (compareVersions(version, best.version) === 0 && ((model.created ?? 0) > (best.model.created ?? 0)
          || ((model.created ?? 0) === (best.model.created ?? 0) && model.id.length < best.model.id.length)))));
    if (better) best = { model, extras, version };
  }
  return best?.model ?? null;
}
