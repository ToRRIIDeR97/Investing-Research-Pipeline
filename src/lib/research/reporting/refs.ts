/**
 * Short reference tokens for report model calls. A report packet carries `ev<n>` for evidence, `ar<n>` for artifacts
 * and `id<n>` for any other UUID instead of the stored ids, and an answer's citation arrays are mapped back to the
 * stored ids in code. Tokens live only in model requests and raw answers; stored rows keep UUIDs.
 */

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EVIDENCE_TOKEN = /^ev\d+$/i;
const ARTIFACT_TOKEN = /^ar\d+$/i;

export interface CitationRefs {
  /** A deep copy of `value` in which every UUID-shaped substring (in keys or strings) is replaced by its token. */
  packet<T>(value: T): T;
  /**
   * A copy of `value` in which every `evidence_ids` array keeps only evidence and every `artifact_ids` array only
   * artifacts, as stored ids, in order and without duplicates; anything else is removed and its raw value added to
   * `dropped`. A string under `artifact_id` that is a known artifact token is mapped too. Any depth.
   */
  resolve<T>(value: T, dropped?: Set<string>): T;
  /** The token for a stored id, when it has one. */
  token(id: string): string | undefined;
}

export function citationRefs(artifacts: { id: string }[], evidence: { id: string }[]): CitationRefs {
  const tokens = new Map<string, string>();
  const evidenceByToken = new Map<string, string>();
  const artifactByToken = new Map<string, string>();
  evidence.forEach((e, i) => {
    const id = String(e.id).toLowerCase();
    if (tokens.has(id)) return;
    tokens.set(id, `ev${i + 1}`); evidenceByToken.set(`ev${i + 1}`, String(e.id));
  });
  artifacts.forEach((a, i) => {
    const id = String(a.id).toLowerCase();
    if (tokens.has(id)) return;
    tokens.set(id, `ar${i + 1}`); artifactByToken.set(`ar${i + 1}`, String(a.id));
  });
  const evidenceIds = new Set(evidenceByToken.values());
  const artifactIds = new Set(artifactByToken.values());
  let others = 0;

  const tokenFor = (id: string) => {
    const key = id.toLowerCase();
    let token = tokens.get(key);
    if (!token) { token = `id${++others}`; tokens.set(key, token); }
    return token;
  };
  const replace = (text: string) => text.replace(UUID, tokenFor);
  const copy = (value: any): any => {
    if (typeof value === "string") return replace(value);
    if (Array.isArray(value)) return value.map(copy);
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if (typeof value.toJSON === "function") return copy(value.toJSON());
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [replace(key), copy(item)]));
    }
    return value;
  };

  const stored = (raw: unknown, byToken: Map<string, string>, ids: Set<string>, pattern: RegExp) => {
    if (typeof raw !== "string") return undefined;
    const value = raw.trim();
    if (pattern.test(value)) return byToken.get(value.toLowerCase());
    if (ids.has(value)) return value;
    const lower = value.toLowerCase();
    for (const id of ids) if (id.toLowerCase() === lower) return id;
    return undefined;
  };
  const keep = (list: unknown[], byToken: Map<string, string>, ids: Set<string>, pattern: RegExp, dropped?: Set<string>) => {
    const out: string[] = [];
    for (const raw of list) {
      const id = stored(raw, byToken, ids, pattern);
      if (id === undefined) dropped?.add(String(raw));
      else if (!out.includes(id)) out.push(id);
    }
    return out;
  };
  const resolveValue = (value: any, dropped?: Set<string>): any => {
    if (Array.isArray(value)) return value.map(item => resolveValue(item, dropped));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (key === "evidence_ids" && Array.isArray(item)) return [key, keep(item, evidenceByToken, evidenceIds, EVIDENCE_TOKEN, dropped)];
      if (key === "artifact_ids" && Array.isArray(item)) return [key, keep(item, artifactByToken, artifactIds, ARTIFACT_TOKEN, dropped)];
      if (key === "artifact_id" && typeof item === "string" && ARTIFACT_TOKEN.test(item.trim()))
        return [key, artifactByToken.get(item.trim().toLowerCase()) ?? item];
      return [key, resolveValue(item, dropped)];
    }));
  };

  return {
    packet: <T>(value: T) => copy(value) as T,
    resolve: <T>(value: T, dropped?: Set<string>) => resolveValue(value, dropped) as T,
    token: (id: string) => tokens.get(String(id).toLowerCase()),
  };
}
