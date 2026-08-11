export type DeadlineReason = "total" | "inactivity" | "caller";

export interface DeadlineController {
  signal: AbortSignal;
  resetInactivity(): void;
  pauseTotal(): void;
  resumeTotal(): void;
  pauseInactivity(): void;
  resumeInactivity(): void;
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
  let expiresAt = Date.now() + totalTimeoutMs;
  let deadlineReason: DeadlineReason | null = null;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  let totalPausedAt: number | undefined;
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  let inactivityPaused = false;

  const abort = (reason: DeadlineReason) => {
    if (controller.signal.aborted) return;
    deadlineReason = reason;
    controller.abort(reason);
  };
  const onParentAbort = () => abort("caller");

  const scheduleTotalTimer = () => {
    if (totalTimer) clearTimeout(totalTimer);
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      abort("total");
      return;
    }
    totalTimer = setTimeout(() => abort("total"), remaining);
  };
  const pauseTotal = () => {
    if (controller.signal.aborted || totalPausedAt !== undefined) return;
    totalPausedAt = Date.now();
    if (totalTimer) clearTimeout(totalTimer);
    totalTimer = undefined;
  };
  const resumeTotal = () => {
    if (totalPausedAt === undefined) return;
    expiresAt += Date.now() - totalPausedAt;
    totalPausedAt = undefined;
    scheduleTotalTimer();
  };
  const resetInactivity = () => {
    if (controller.signal.aborted) return;
    if (inactivityPaused) return;
    if (Date.now() >= expiresAt && totalPausedAt === undefined) {
      abort("total");
      return;
    }
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => abort("inactivity"), inactivityTimeoutMs);
  };
  const pauseInactivity = () => {
    inactivityPaused = true;
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = undefined;
  };
  const resumeInactivity = () => {
    inactivityPaused = false;
    resetInactivity();
  };
  if (parentSignal?.aborted) abort("caller");
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  if (!controller.signal.aborted) {
    scheduleTotalTimer();
    resetInactivity();
  }

  return {
    signal: controller.signal,
    resetInactivity,
    pauseTotal,
    resumeTotal,
    pauseInactivity,
    resumeInactivity,
    reason: () => deadlineReason,
    remainingMs: () => Math.max(0, expiresAt - (totalPausedAt ?? Date.now())),
    cleanup: () => {
      if (totalTimer) clearTimeout(totalTimer);
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
