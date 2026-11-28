/**
 * Resolves `latest:<family>` model aliases against the provider's own model list, so a new release is used without
 * a config change. The list is cached per provider endpoint for RESEARCH_MODEL_LIST_TTL_MS (default one hour); when a
 * refresh fails the last good list is used. Concrete model IDs pass through untouched.
 */
import { ProviderError } from "./errors";
import { latestAliasWords, pickLatest, type ListedModel } from "./model-family";
import type { ModelProvider } from "./types";

interface CacheEntry { models: ListedModel[]; fetchedAt: number }
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ListedModel[]>>();

function ttlMs() {
  const value = Number(process.env.RESEARCH_MODEL_LIST_TTL_MS);
  return Number.isFinite(value) && value >= 0 ? value : 60 * 60 * 1_000;
}

const cacheKey = (provider: ModelProvider) => `${provider.id}|${provider.endpoint ?? ""}`;

/** The provider's models, from cache when fresh. Falls back to a stale list when a refresh fails. */
export async function providerModels(provider: ModelProvider, now = Date.now()): Promise<ListedModel[]> {
  if (!provider.listModels) throw new ProviderError(`${provider.id} cannot list its models, so latest: aliases can't be resolved`, "invalid_request");
  const key = cacheKey(provider);
  const hit = cache.get(key);
  if (hit && now - hit.fetchedAt < ttlMs()) return hit.models;
  const pending = inflight.get(key) ?? provider.listModels().then((models) => {
    if (!models.length) throw new ProviderError("The provider listed no models", "server_error");
    cache.set(key, { models, fetchedAt: Date.now() });
    return models;
  }).finally(() => inflight.delete(key));
  inflight.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    if (hit) return hit.models;
    throw error;
  }
}

/** A concrete model ID for `model`: the alias's newest family member, or `model` itself when it is not an alias. */
export async function resolveModel(model: string, provider: ModelProvider): Promise<string> {
  const words = latestAliasWords(model);
  if (!words) return model;
  // The mock provider answers any model name; nothing to look up.
  if (provider.id === "mock") return model;
  const found = pickLatest(words, await providerModels(provider));
  if (!found) throw new ProviderError(`No model the provider lists matches ${model.trim()}`, "invalid_request");
  return found.id;
}

/** Resolves every candidate in order (repeats kept: they are the attempt sequence), looking each alias up once. */
export async function resolveModels(models: string[], provider: ModelProvider): Promise<string[]> {
  const resolved = new Map<string, string>();
  for (const model of new Set(models)) resolved.set(model, await resolveModel(model, provider));
  return models.map((model) => resolved.get(model)!);
}

/** Tests only. */
export function clearModelListCache() {
  cache.clear();
  inflight.clear();
}
