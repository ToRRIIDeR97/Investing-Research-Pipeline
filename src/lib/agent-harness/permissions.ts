import { ProviderError } from "./errors";
import type { PermissionDecision, PermissionEffect, PermissionRequest, PermissionRule } from "./types";

function matches(pattern: string, value: string) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

export function evaluatePermission(
  rules: PermissionRule[],
  action: string,
  resource: string,
  fallback: PermissionEffect = "ask"
): PermissionEffect {
  let effect = fallback;
  for (const rule of rules) {
    if (matches(rule.action, action) && matches(rule.resource, resource)) effect = rule.effect;
  }
  return effect;
}

export class PermissionService {
  private readonly savedRules: PermissionRule[] = [];

  constructor(
    private readonly rules: PermissionRule[],
    private readonly ask?: (request: PermissionRequest) => Promise<PermissionDecision> | PermissionDecision
  ) {}

  async authorize(request: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision> {
    const effect = evaluatePermission([...this.rules, ...this.savedRules], request.action, request.resource);
    if (effect === "allow") return "allow_once";
    if (effect === "deny") {
      throw new ProviderError(`Permission denied for ${request.action} ${request.resource}`, "permission_denied");
    }
    if (!this.ask) {
      throw new ProviderError(`Permission approval required for ${request.action} ${request.resource}`, "permission_denied");
    }
    if (signal.aborted) throw new ProviderError("Permission request cancelled", "cancellation");

    let abortHandler: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      abortHandler = () => reject(new ProviderError("Permission request cancelled", "cancellation"));
      signal.addEventListener("abort", abortHandler, { once: true });
    });
    try {
      const decision = await Promise.race([Promise.resolve(this.ask(request)), cancelled]);
      if (!(["allow_once", "allow_always", "deny"] as const).includes(decision)) {
        throw new ProviderError("Permission callback returned an invalid decision", "permission_denied");
      }
      if (decision === "deny") {
        throw new ProviderError(`Permission denied for ${request.action} ${request.resource}`, "permission_denied");
      }
      if (decision === "allow_always") {
        this.savedRules.push({ action: request.action, resource: request.resource, effect: "allow" });
      }
      return decision;
    } finally {
      if (abortHandler) signal.removeEventListener("abort", abortHandler);
    }
  }
}
