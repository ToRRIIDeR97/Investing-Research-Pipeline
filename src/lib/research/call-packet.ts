// Size cap for analysis-stage packets. Report packets have their own cap (fitPacket, reporting/packet.ts).
import { cappedArtifactView } from "./reporting/packet";

type Row = Record<string, any>;

/**
 * Most bytes an analysis-stage packet may carry. Haiku 5.5 bills a prompt over 100K input tokens at five times its
 * rate; analysis calls log 0.42 to 0.48 tokens per prompt byte (SoFi 7c70364e), so 160 KB plus about 12 KB of rules
 * stays near 82K tokens. On that run, 30 of 106 calls went over the threshold and cost $3.92 of $4.83.
 */
export const ANALYSIS_PACKET_BYTES = 160_000;
/**
 * Bytes held back for per-call keys (a team answer's request and passages, about 21 KB on SoFi). The shared part is
 * fitted alone, against the budget less this reserve, so sibling calls keep the same cached prefix.
 */
export const PER_CALL_RESERVE_BYTES = 24_000;
/**
 * Stages whose calls are capped: the analysis branch and the decision. Data stages send per-call document batches,
 * and the report stages fit their own packets to REPORT_PACKET_BYTES.
 */
export const ANALYSIS_PACKET_STAGES: ReadonlySet<string> = new Set(["historical_record", "company_genesis", "historical_diagnosis",
  "business_process_analysis", "moat_analysis", "operating_model", "operating_scenarios", "asset_valuation", "decision_synthesis"]);

/** Keys the cap never changes: identity, the output contract and the run's framing. */
const FIXED_KEYS = new Set(["asset", "output_contract", "output_schema", "artifact_shape", "research_framing", "request", "role",
  "source_search_attempted", "required_modules", "required_scenario_drivers", "required_process_nodes", "forecast_period"]);
const EVIDENCE_KEYS = ["evidence_claims", "evidence"];
const MIN_CLAIMS = 20;
const MIN_TABLE_ROWS = 3;

export const CAPPED_PACKET_RULE = "This packet was shortened to fit the prompt size limit. packet_cap lists what was left out: "
  + "omitted_fields on an artifact or in packet_cap.omitted_inputs name fields not sent, omitted_artifacts names artifacts not sent, "
  + "and omitted_claims counts accepted evidence claims not sent. Do not treat an omitted input as empty or missing from the research; "
  + "rely on what is supplied and say so where an omitted input would matter. An array shown as {columns, rows} is a table: each row "
  + "holds one item's values in column order. An upstream artifact with content_in carries no content because the packet already holds it at that key.";

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value ?? null));
const isPlain = (value: unknown): value is Row => Boolean(value) && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);

/** JSON with sorted keys, so equal content read through different paths compares equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isPlain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

/**
 * Arrays of at least three objects with the same keys become {columns, rows}; nothing is dropped. Reported history
 * repeats its four keys on every row (129 KB for 222 metrics on SoFi), so the table form roughly halves it.
 */
export function tabulateRows(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(tabulateRows);
    if (items.length < MIN_TABLE_ROWS || !items.every(isPlain)) return items;
    const columns = Object.keys(items[0] as Row);
    const same = (items as Row[]).every(item => Object.keys(item).length === columns.length && columns.every(column => column in item));
    return same && columns.length ? { columns, rows: (items as Row[]).map(item => columns.map(column => item[column])) } : items;
  }
  if (!isPlain(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, tabulateRows(child)]));
}

type Lists = { top: boolean; upstream: boolean };
const isArtifact = (value: unknown): value is Row & { content_json: any } => isPlain(value) && "content_json" in value;

/**
 * Shrinks an analysis-stage packet to `budget` bytes in fixed steps, stopping at the first that fits. Two steps drop
 * nothing: upstream artifacts the packet already carries under another key are sent as a pointer (content_in), and
 * row arrays become tables. Then: artifacts (packet.artifacts and team_context.upstream_artifacts) capped at 8 KB per
 * field, then 2 KB; claims (evidence_claims or evidence) without quotes; the most claims that fit, cut from the end and
 * never below 20; the largest artifacts dropped; last, the stage's own large inputs cut to 8 KB, then 2 KB per part
 * (capNested). Whatever is left out is named in packet_cap. A packet that already fits is returned unchanged.
 */
export function fitAnalysisPacket<P extends Record<string, any>>(packet: P, budget = ANALYSIS_PACKET_BYTES): P {
  let current: Row = packet;
  const cap: Row = {};
  if (bytes(current) <= budget) return packet;
  // packet_cap counts toward the budget.
  const fits = () => bytes({ ...current, packet_cap: cap }) <= budget;
  const done = () => ({ ...current, packet_cap: cap }) as unknown as P;
  const lists: Lists = { top: Array.isArray(current.artifacts), upstream: Array.isArray(current.team_context?.upstream_artifacts) };
  const mapArtifacts = (map: (list: any[]) => any[]) => {
    if (lists.top) current = { ...current, artifacts: map(current.artifacts) };
    if (lists.upstream) current = { ...current, team_context: { ...current.team_context, upstream_artifacts: map(current.team_context.upstream_artifacts) } };
  };
  const inputKeys = () => Object.keys(current).filter(key => !FIXED_KEYS.has(key) && !EVIDENCE_KEYS.includes(key)
    && key !== "artifacts" && key !== "team_context" && key !== "packet_cap");

  // 1. An upstream artifact the handler already sends is a pointer, not a second copy: the packet holds the same
  // content, or a view under the artifact's type name (decision_synthesis sends accepted_valuation.valuation_scenario_set),
  // as a key or one level down. The handler's view is the one the stage reads.
  const carried = new Map<string, string>();
  const named = new Map<string, string>();
  for (const key of inputKeys()) {
    const value = current[key];
    if (isPlain(value) || Array.isArray(value)) { carried.set(canonical(value), key); named.set(key, key); }
    if (isPlain(value)) for (const [child, inner] of Object.entries(value)) if (isPlain(inner) || Array.isArray(inner)) {
      carried.set(canonical(inner), `${key}.${child}`);
      if (!named.has(child)) named.set(child, `${key}.${child}`);
    }
  }
  mapArtifacts(list => list.map(artifact => {
    if (!isArtifact(artifact)) return artifact;
    const at = carried.get(canonical(artifact.content_json)) ?? named.get(String(artifact.artifact_type));
    if (!at) return artifact;
    const { content_json: _, ...rest } = artifact; // eslint-disable-line @typescript-eslint/no-unused-vars
    return { ...rest, content_in: at };
  }));
  if (fits()) return done();

  // 2. Row arrays as tables, in the stage's inputs and in artifact content.
  for (const key of inputKeys()) current = { ...current, [key]: tabulateRows(current[key]) };
  mapArtifacts(list => list.map(artifact => isArtifact(artifact) ? { ...artifact, content_json: tabulateRows(artifact.content_json) } : artifact));
  if (fits()) return done();

  // 3. Artifact fields over 8 KB, then 2 KB, are named in the artifact's omitted_fields.
  for (const fieldBytes of [8192, 2048]) {
    mapArtifacts(list => list.map(artifact => isArtifact(artifact) ? cappedArtifactView(artifact, fieldBytes) : artifact));
    if (fits()) return done();
  }

  // 4 and 5. Claims without their quotes, then the most claims that fit, cut from the end (the packet's lowest-ranked)
  // and never below 20.
  const evidenceKey = EVIDENCE_KEYS.find(key => Array.isArray(current[key]));
  if (evidenceKey) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const claims: any[] = current[evidenceKey].map((claim: any) => isPlain(claim) ? (({ quote, ...rest }) => rest)(claim) : claim);
    const withClaims = (count: number) => ({ ...current, [evidenceKey]: claims.slice(0, count) });
    current = withClaims(claims.length);
    cap.claim_quotes_omitted = true;
    if (!fits() && claims.length > MIN_CLAIMS) {
      let [low, high] = [MIN_CLAIMS, claims.length - 1];
      const base = current;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        current = { ...base, [evidenceKey]: claims.slice(0, mid) };
        cap.omitted_claims = claims.length - mid;
        if (fits()) low = mid; else high = mid - 1;
      }
      current = { ...base, [evidenceKey]: claims.slice(0, low) };
      cap.omitted_claims = claims.length - low;
    }
    if (fits()) return done();
  }

  // 6. The largest artifacts go, in catalogue order otherwise, named in omitted_artifacts. Pointers stay.
  const all = ([...(lists.top ? current.artifacts : []), ...(lists.upstream ? current.team_context.upstream_artifacts : [])] as any[])
    .filter(artifact => !(isPlain(artifact) && "content_in" in artifact));
  const dropped = new Set<any>();
  for (const artifact of [...all].sort((a, b) => bytes(b) - bytes(a))) {
    if (fits()) break;
    dropped.add(artifact);
    mapArtifacts(list => list.filter(item => item !== artifact));
    cap.omitted_artifacts = [...dropped].map(item => item?.artifact_type ?? item?.id);
  }
  if (fits()) return done();

  // 7. The stage's own inputs, largest first: nested fields over 8 KB, then 2 KB, are left out and long arrays and
  // tables keep their first entries, each named in omitted_inputs.
  for (const fieldBytes of [8192, 2048]) {
    for (const key of inputKeys().sort((a, b) => bytes(current[b]) - bytes(current[a]))) {
      if (bytes(current[key]) <= fieldBytes) continue;
      const omitted: string[] = [];
      current = { ...current, [key]: capNested(current[key], fieldBytes, key, omitted) };
      if (omitted.length) cap.omitted_inputs = [...(cap.omitted_inputs ?? []), ...omitted];
      if (fits()) return done();
    }
  }
  return done();
}

/**
 * A value cut to about `limit` bytes per part: object fields within the limit stay, larger objects are cut the same
 * way one level down, and arrays (or a table's rows) keep their first entries that fit. Strings and other values over
 * the limit are left out. Each cut is recorded in `omitted` by path.
 */
function capNested(value: unknown, limit: number, path: string, omitted: string[]): unknown {
  if (bytes(value) <= limit) return value;
  if (Array.isArray(value)) {
    const kept: unknown[] = [];
    let size = 2;
    for (const item of value) {
      size += bytes(item) + 1;
      if (size > limit) break;
      kept.push(item);
    }
    omitted.push(`${path} (${value.length - kept.length} of ${value.length} entries)`);
    return kept;
  }
  if (!isPlain(value)) {
    omitted.push(path);
    return undefined;
  }
  const out: Row = {};
  for (const [field, child] of Object.entries(value)) {
    const capped = isPlain(child) || Array.isArray(child) ? capNested(child, limit, `${path}.${field}`, omitted)
      : bytes(child) <= limit ? child : (omitted.push(`${path}.${field}`), undefined);
    if (capped !== undefined) out[field] = capped;
  }
  return out;
}

/**
 * The cap as a call applies it: per-call keys stay out of the fitted part and follow it unchanged, so siblings that
 * differ only in them send the same capped prefix and share its cache entry.
 */
export function fitCallPacket(packet: Record<string, unknown>, perCallKeys: string[] = [], budget = ANALYSIS_PACKET_BYTES) {
  const perCall = perCallKeys.filter(key => key in packet);
  if (!perCall.length) return fitAnalysisPacket(packet, budget);
  const shared = Object.fromEntries(Object.entries(packet).filter(([key]) => !perCall.includes(key)));
  const fitted = fitAnalysisPacket(shared, budget - PER_CALL_RESERVE_BYTES);
  return fitted === shared ? packet : { ...fitted, ...Object.fromEntries(perCall.map(key => [key, packet[key]])) };
}
