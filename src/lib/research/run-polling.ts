/** A run page polls only while the run, or a job queued for it, can still change. */
export function runProgressIsLive(runStatus?: string | null, jobStatus?: string | null): boolean {
  return runStatus === "running" || jobStatus === "queued" || jobStatus === "running";
}

/** An interval callback that skips a tick while the previous one is in flight or while `paused()` is true. */
export function pollTick(task: () => Promise<unknown>, paused: () => boolean): () => void {
  let inFlight = false;
  return () => {
    if (inFlight || paused()) return;
    inFlight = true;
    void task().finally(() => { inFlight = false; });
  };
}
