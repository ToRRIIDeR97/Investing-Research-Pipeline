/**
 * Research OS v3 stage-handler registry.
 *
 * Every executable v3 stage must register a bounded handler. Registration
 * rejects duplicate stage keys at startup, and the runner fails closed when
 * a stage has no handler: an unimplemented stage is never silently marked
 * completed.
 */

import type { V3RunContext, V3StageHandler } from "./v3-context";
import type { ValidationResult } from "@/lib/workflow/validators";

const registry = new Map<string, V3StageHandler<unknown>>();

export function registerV3StageHandler<TOutput>(handler: V3StageHandler<TOutput>): void {
  if (!handler || typeof handler.stageKey !== "string" || !handler.stageKey) {
    throw new Error("V3 stage handler must declare a non-empty stageKey");
  }
  if (registry.has(handler.stageKey)) {
    console.warn(`V3 stage handler for stage "${handler.stageKey}" is already registered.`);
    return;
  }
  registry.set(handler.stageKey, handler as V3StageHandler<unknown>);
}

export function getV3StageHandler(stageKey: string): V3StageHandler<unknown> | undefined {
  return registry.get(stageKey);
}

export function hasV3StageHandler(stageKey: string): boolean {
  return registry.has(stageKey);
}

export function listV3StageHandlerKeys(): string[] {
  return [...registry.keys()].sort();
}

/** Test-only: reset the registry so duplicate-registration tests isolate. */
export function resetV3StageRegistryForTests(): void {
  registry.clear();
}

export type { V3RunContext, V3StageHandler, ValidationResult };
