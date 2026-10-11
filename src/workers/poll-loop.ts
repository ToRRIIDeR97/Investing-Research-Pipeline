export function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Retry a short job-state write, so a database blip neither leaves a finished job running nor marks it failed. */
export async function withRetries<T>(write: () => Promise<T>, attempts = 3, delayMs = 1_000): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await write();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await sleep(delayMs * attempt);
    }
  }
}

/**
 * Run `step` until stopped. `step` returns whether it found work; when idle the loop waits `pollIntervalMs`.
 * A failing step (for example Postgres restarting) is logged and retried after 5 s, doubling to 60 s,
 * instead of ending the worker. With `once`, `step` runs a single time and a failure is thrown.
 */
export async function pollUntilStopped(step: () => Promise<boolean>, options: {
  once?: boolean; pollIntervalMs: number; signal: AbortSignal; errorDelayMs?: number; log?: (message: string, error: unknown) => void;
}) {
  if (options.once) {
    await step();
    return;
  }
  const baseDelay = options.errorDelayMs ?? 5_000;
  let failures = 0;
  while (!options.signal.aborted) {
    try {
      const worked = await step();
      failures = 0;
      if (!worked) await sleep(options.pollIntervalMs, options.signal);
    } catch (error) {
      failures += 1;
      const delay = Math.min(60_000, baseDelay * 2 ** (failures - 1));
      (options.log ?? ((message, cause) => console.error(message, cause)))(`research-worker poll failed; retrying in ${delay} ms:`, error);
      await sleep(delay, options.signal);
    }
  }
}
