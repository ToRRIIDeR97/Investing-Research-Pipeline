import { ProviderError } from "./errors";

interface ActiveExecution {
  operationId: string;
  promise: Promise<unknown>;
}

/** Process-local single-flight guard. Durable ownership remains the research job/task lease. */
export class SessionCoordinator {
  private readonly active = new Map<string, ActiveExecution>();

  run<T>(sessionId: string, operationId: string, execute: () => Promise<T>): Promise<T> {
    const current = this.active.get(sessionId);
    if (current) {
      if (current.operationId !== operationId) {
        throw new ProviderError(`Agent session ${sessionId} is already running another operation`, "invalid_request");
      }
      return current.promise as Promise<T>;
    }

    const promise = execute().finally(() => {
      if (this.active.get(sessionId)?.promise === promise) this.active.delete(sessionId);
    });
    this.active.set(sessionId, { operationId, promise });
    return promise;
  }

  isActive(sessionId: string) {
    return this.active.has(sessionId);
  }
}

export const sessionCoordinator = new SessionCoordinator();
