/**
 * Provider prompt-cache support, adapted from the Codetonomy foundation harness
 * (packages/runtime/src/cache-shape.ts).
 *
 * Providers reuse a processed prompt only when a request starts with exactly the
 * bytes of an earlier one and reaches the same cache. Requests therefore carry a
 * stable instruction prefix, and an opaque affinity key that keeps related
 * requests together. Telemetry here records hashes and sizes, never content.
 */

import { createHash, createHmac } from "node:crypto";

const PACKET_MARKER = "\n\nTask packet:";

/**
 * Agent prompts end with their task packet. Everything before it is the agent's
 * instructions, which are identical across calls with the same agent and rules,
 * so they become the system message and the packet becomes the user message.
 * A prompt without the marker stays a single user message.
 */
export function promptMessages(prompt: string): { system?: string; prompt: string } {
  const at = prompt.lastIndexOf(PACKET_MARKER);
  if (at <= 0) return { prompt };
  return { system: prompt.slice(0, at), prompt: prompt.slice(at + 2) };
}

export interface CacheAffinityInput {
  /** Local grouping such as a research run ID. Used only as an HMAC key. */
  scopeId: string;
  providerId: string;
  modelId: string;
  /** Hash of the stable instructions; requests with different instructions cannot share a prefix. */
  stablePrefixHash: string;
}

/**
 * Provider-safe affinity key from an opaque local scope. Raw run, user and asset
 * identifiers never leave the application.
 */
export function deriveCacheAffinityId(input: CacheAffinityInput): string {
  if (!input.scopeId.trim()) throw new Error("Cache affinity scope must not be empty");
  const payload = JSON.stringify({
    providerId: input.providerId,
    modelId: input.modelId,
    stablePrefixHash: input.stablePrefixHash,
  });
  return createHmac("sha256", input.scopeId).update(payload).digest("hex");
}

export type CacheMissReason =
  | "first-request"
  | "prefix-changed"
  | "affinity-changed"
  | "previous-in-flight"
  | "unexplained-provider-miss"
  | "none";

export interface WireRequestObservation {
  providerId: string;
  modelId: string;
  wireRequestHash: string;
  wireBytes: number;
  wireEstimatedTokens: number;
  stablePrefixHash: string;
  stablePrefixBytes: number;
  stablePrefixEstimatedTokens: number;
  dynamicTailHash: string;
  dynamicTailBytes: number;
  dynamicTailEstimatedTokens: number;
  systemPromptHash: string;
  stableConfigurationHash: string;
  affinityIdHash?: string;
}

const hashText = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const json = (value: unknown): string => JSON.stringify(value) ?? "null";
const estimatedTokens = (bytes: number): number => Math.ceil(bytes / 4);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const stablePrefixHash = (system: string | undefined): string => hashText(system ?? "");

const isStableEntry = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  const role = value.role ?? value.type;
  return role === "system" || role === "developer";
};

// Fields that vary per request without changing what the provider can reuse.
const DYNAMIC_FIELDS = new Set(["messages", "input", "contents", "max_tokens", "max_completion_tokens", "max_output_tokens",
  "stream", "stream_options", "prompt_cache_key", "session_id", "metadata"]);

/** Content-free cache telemetry from the exact serialized provider body. */
export function observeWireRequest(
  payload: string,
  input: { providerId: string; modelId: string; affinityId?: string },
): WireRequestObservation {
  const body = JSON.parse(payload) as unknown;
  if (!isRecord(body)) throw new Error("Provider payload must be a JSON object");
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let stableCount = 0;
  while (stableCount < messages.length && isStableEntry(messages[stableCount])) stableCount += 1;
  const configuration = Object.fromEntries(Object.entries(body).filter(([key]) => !DYNAMIC_FIELDS.has(key)));
  const stablePrefix = json({ ...configuration, messages: messages.slice(0, stableCount) });
  const dynamicTail = json(messages.slice(stableCount));
  const wireBytes = Buffer.byteLength(payload, "utf8");
  const stableBytes = Buffer.byteLength(stablePrefix, "utf8");
  const dynamicBytes = Buffer.byteLength(dynamicTail, "utf8");
  return {
    providerId: input.providerId,
    modelId: input.modelId,
    wireRequestHash: hashText(payload),
    wireBytes,
    wireEstimatedTokens: estimatedTokens(wireBytes),
    stablePrefixHash: hashText(stablePrefix),
    stablePrefixBytes: stableBytes,
    stablePrefixEstimatedTokens: estimatedTokens(stableBytes),
    dynamicTailHash: hashText(dynamicTail),
    dynamicTailBytes: dynamicBytes,
    dynamicTailEstimatedTokens: estimatedTokens(dynamicBytes),
    systemPromptHash: hashText(json({ entries: messages.slice(0, stableCount), system: body.system ?? null })),
    stableConfigurationHash: hashText(json(configuration)),
    ...(input.affinityId ? { affinityIdHash: hashText(input.affinityId) } : {}),
  };
}

export function commonPrefixBytes(previous: string, next: string): number {
  const left = Buffer.from(previous, "utf8");
  const right = Buffer.from(next, "utf8");
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

export function classifyCacheMiss(
  previous: { observation: WireRequestObservation; inFlight: boolean } | undefined,
  next: WireRequestObservation,
  providerCacheRead: number,
): CacheMissReason {
  // A provider cache can be shared beyond one affinity group, so a hit is never reported as a miss.
  if (providerCacheRead > 0) return "none";
  if (!previous) return "first-request";
  const prior = previous.observation;
  if (prior.providerId !== next.providerId || prior.modelId !== next.modelId || prior.affinityIdHash !== next.affinityIdHash) return "affinity-changed";
  if (prior.stablePrefixHash !== next.stablePrefixHash) return "prefix-changed";
  // Automatic-prefix providers publish a cache entry once the earlier request completes.
  return previous.inFlight ? "previous-in-flight" : "unexplained-provider-miss";
}

interface TrackedRequest { payload: string; observation: WireRequestObservation; inFlight: boolean }

export interface WireRequestRecord {
  observation: WireRequestObservation;
  previous?: { observation: WireRequestObservation; inFlight: boolean };
  commonPrefixBytes: number;
}

/**
 * Remembers the last request sent in each affinity group so the next one can be
 * compared with it. Bounded: payloads are held in memory only, never persisted.
 */
export class WireRequestTracker {
  private readonly entries = new Map<string, TrackedRequest>();

  constructor(private readonly maxEntries = 16, private readonly maxPayloadBytes = 2 * 1024 * 1024) {}

  record(key: string, payload: string, observation: WireRequestObservation): WireRequestRecord {
    const previous = this.entries.get(key);
    this.entries.delete(key);
    const keepPayload = observation.wireBytes <= this.maxPayloadBytes;
    this.entries.set(key, { payload: keepPayload ? payload : "", observation, inFlight: true });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    return {
      observation,
      ...(previous ? { previous: { observation: previous.observation, inFlight: previous.inFlight } } : {}),
      commonPrefixBytes: previous?.payload && keepPayload ? commonPrefixBytes(previous.payload, payload) : 0,
    };
  }

  complete(key: string, wireRequestHash: string): void {
    const entry = this.entries.get(key);
    if (entry?.observation.wireRequestHash === wireRequestHash) entry.inFlight = false;
  }
}

export const wireRequestTracker = new WireRequestTracker();

export interface PassCacheTelemetry extends WireRequestObservation {
  commonPrefixBytes: number;
  commonPrefixEstimatedTokens: number;
  cacheUsageReported: boolean;
  cacheMissReason?: CacheMissReason;
}

export function passCacheTelemetry(record: WireRequestRecord, cacheReadTokens: number | undefined): PassCacheTelemetry {
  return {
    ...record.observation,
    commonPrefixBytes: record.commonPrefixBytes,
    commonPrefixEstimatedTokens: estimatedTokens(record.commonPrefixBytes),
    cacheUsageReported: cacheReadTokens !== undefined,
    ...(cacheReadTokens === undefined ? {} : { cacheMissReason: classifyCacheMiss(record.previous, record.observation, cacheReadTokens) }),
  };
}
