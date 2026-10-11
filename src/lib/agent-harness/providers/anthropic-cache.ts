/**
 * Prompt-cache breakpoints for the Anthropic Messages protocol
 * (https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
 *
 * Claude models get up to two of the four allowed breakpoints, both stable-first:
 *   1. the system block (agent instructions, shared by every call of that agent);
 *   2. the end of the repeatable part of the task prompt (`cacheablePromptChars`): the context
 *      sibling calls share when the caller names per-call packet keys, so report sections,
 *      extraction batches and same-owner answers read it from cache; otherwise the whole task
 *      prompt, which a transport retry, fallback or repair resends. What follows the breakpoint
 *      (per-call keys, a repair's appended instructions) is a separate, uncached block.
 * Prompts below the model minimum (512 tokens for Claude 5.5 models) are processed uncached
 * without an error, so no length check is needed here.
 *
 * Other models on this protocol (OpenCode Go's /messages route) keep the single system
 * breakpoint they had before.
 */
import type { ModelRequest } from "../types";

export type AnthropicCacheTtl = "5m" | "1h";

export interface AnthropicCacheSettings {
  /** RESEARCH_ANTHROPIC_CACHE_CONTROL=0 sends no cache_control at all. */
  enabled: boolean;
  /** RESEARCH_ANTHROPIC_CACHE_PROMPT=0 keeps only the system breakpoint for Claude models. */
  promptBreakpoint: boolean;
  /** RESEARCH_ANTHROPIC_CACHE_TTL=1h writes cost 2x input instead of 1.25x; reads cost the same. */
  ttl: AnthropicCacheTtl;
}

export function anthropicCacheSettings(env: NodeJS.ProcessEnv = process.env): AnthropicCacheSettings {
  return {
    enabled: env.RESEARCH_ANTHROPIC_CACHE_CONTROL !== "0",
    promptBreakpoint: env.RESEARCH_ANTHROPIC_CACHE_PROMPT !== "0",
    ttl: env.RESEARCH_ANTHROPIC_CACHE_TTL === "1h" ? "1h" : "5m",
  };
}

export const isClaudeModel = (model: string) => /^claude-/i.test(model);

type TextBlock = { type: "text"; text: string; cache_control?: { type: "ephemeral"; ttl?: "1h" } };

/** The system and messages fields of a Messages request, with cache breakpoints placed. */
export function anthropicPromptFields(request: ModelRequest, settings: AnthropicCacheSettings = anthropicCacheSettings()) {
  const claude = isClaudeModel(request.model);
  // Same TTL on every breakpoint, so the longer-before-shorter ordering rule always holds.
  const marker = settings.enabled
    ? { type: "ephemeral" as const, ...(claude && settings.ttl === "1h" ? { ttl: "1h" as const } : {}) } : undefined;
  const system = request.system
    ? marker ? [{ type: "text", text: request.system, cache_control: marker } as TextBlock] : request.system
    : undefined;
  let content: string | TextBlock[] = request.prompt;
  if (marker && claude && settings.promptBreakpoint && request.prompt) {
    const at = Math.min(Math.max(0, request.cacheablePromptChars ?? request.prompt.length), request.prompt.length);
    const head = request.prompt.slice(0, at), tail = request.prompt.slice(at);
    // Empty text blocks cannot carry cache_control, so a prompt with no repeatable head stays uncached.
    content = head ? [{ type: "text", text: head, cache_control: marker }, ...(tail ? [{ type: "text" as const, text: tail }] : [])] : request.prompt;
  }
  return { ...(system ? { system } : {}), messages: [{ role: "user" as const, content }] };
}
