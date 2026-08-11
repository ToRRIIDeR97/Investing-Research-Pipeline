import { ProviderError } from "../errors";

const queues = new Map<string, Promise<void>>();

function cancellation() {
  return new ProviderError("Provider request cancelled", "cancellation");
}

async function waitForTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await previous;
    return;
  }
  if (signal.aborted) throw cancellation();

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(cancellation());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    previous.then(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }, (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

/** Serialize streamed model requests for each provider endpoint. */
export async function acquireProviderRequestLock(
  endpoint: string,
  signal?: AbortSignal,
): Promise<() => void> {
  const previous = queues.get(endpoint) || Promise.resolve();
  let releaseTurn!: () => void;
  const turn = new Promise<void>((resolve) => { releaseTurn = resolve; });
  queues.set(endpoint, turn);

  try {
    await waitForTurn(previous, signal);
  } catch (error) {
    releaseTurn();
    if (queues.get(endpoint) === turn) queues.delete(endpoint);
    throw error;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseTurn();
    if (queues.get(endpoint) === turn) queues.delete(endpoint);
  };
}
