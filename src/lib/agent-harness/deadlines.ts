export type DeadlineReason = "total" | "inactivity" | "caller";

export interface DeadlineController {
  signal: AbortSignal;
  resetInactivity(): void;
  reason(): DeadlineReason | null;
  remainingMs(): number;
  cleanup(): void;
}

export function createDeadlineController(
  parentSignal: AbortSignal | undefined,
  totalTimeoutMs: number,
  inactivityTimeoutMs: number
): DeadlineController {
  const controller = new AbortController();
  const expiresAt = Date.now() + totalTimeoutMs;
  let deadlineReason: DeadlineReason | null = null;
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;

  const abort = (reason: DeadlineReason) => {
    if (controller.signal.aborted) return;
    deadlineReason = reason;
    controller.abort(reason);
  };
  const onParentAbort = () => abort("caller");
  // An already-aborted signal never fires its abort event.
  if (parentSignal?.aborted) abort("caller");
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  const totalTimer = setTimeout(() => abort("total"), totalTimeoutMs);
  const resetInactivity = () => {
    if (Date.now() >= expiresAt) {
      abort("total");
      return;
    }
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => abort("inactivity"), inactivityTimeoutMs);
  };
  resetInactivity();

  return {
    signal: controller.signal,
    resetInactivity,
    reason: () => deadlineReason,
    remainingMs: () => Math.max(0, expiresAt - Date.now()),
    cleanup: () => {
      clearTimeout(totalTimer);
      if (inactivityTimer) clearTimeout(inactivityTimer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}

export async function withDeadlines<T>(
  operationFn: (signal: AbortSignal, resetInactivity: () => void) => Promise<T>,
  totalTimeoutMs: number,
  inactivityTimeoutMs: number,
  parentSignal?: AbortSignal
): Promise<T> {
  const deadline = createDeadlineController(parentSignal, totalTimeoutMs, inactivityTimeoutMs);
  try {
    return await operationFn(deadline.signal, deadline.resetInactivity);
  } catch (error) {
    if (deadline.signal.aborted) {
      const reason = deadline.reason();
      const timeout = reason === "total" || reason === "inactivity";
      const wrapped = new Error(timeout ? `Operation ${reason} timeout` : "Operation cancelled");
      wrapped.name = timeout ? "TimeoutError" : "AbortError";
      throw wrapped;
    }
    throw error;
  } finally {
    deadline.cleanup();
  }
}
