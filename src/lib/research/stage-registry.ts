/**
 * Research OS stage-handler registry.
 *
 * Every executable stage must register a bounded handler. Registration
 * rejects duplicate stage keys at startup, and the runner fails closed when
 * a stage has no handler: an unimplemented stage is never silently marked
 * completed.
 */

import type { ResearchRunContext, StageHandler } from "./run-context";
import type { ValidationResult } from "@/lib/workflow/validators";

const registry = new Map<string, StageHandler<unknown>>();

export function registerStageHandler<TOutput>(handler: StageHandler<TOutput>): void {
  if (!handler || typeof handler.stageKey !== "string" || !handler.stageKey) {
    throw new Error("stage handler must declare a non-empty stageKey");
  }
  if (registry.has(handler.stageKey)) {
    console.warn(`stage handler for stage "${handler.stageKey}" is already registered.`);
    return;
  }
  registry.set(handler.stageKey, handler as StageHandler<unknown>);
}

export function getStageHandler(stageKey: string): StageHandler<unknown> | undefined {
  return registry.get(stageKey);
}

export function hasStageHandler(stageKey: string): boolean {
  return registry.has(stageKey);
}

export function listStageHandlerKeys(): string[] {
  return [...registry.keys()].sort();
}

/** Test-only: reset the registry so duplicate-registration tests isolate. */
export function resetStageRegistryForTests(): void {
  registry.clear();
}

export type { ResearchRunContext, StageHandler, ValidationResult };
