import { ProviderError } from "../errors";

type Queue = { active: number; limit: number; waiting: Array<() => void> };
// ponytail: process-local endpoint limit. Use a database lease before running multiple provider workers.
const queues = new Map<string, Queue>();

/** Keep one stream by default; opt into two only after validating the provider route. */
export async function acquireProviderRequestLock(
  endpoint: string,
  signal?: AbortSignal,
): Promise<() => void> {
  if (signal?.aborted) throw new ProviderError('Provider request cancelled', 'cancellation');
  const configured = Number(process.env.RESEARCH_PROVIDER_CONCURRENCY || 1);
  const limit = configured === 2 ? 2 : 1;
  const queue = queues.get(endpoint) || { active: 0, limit, waiting: [] };
  queues.set(endpoint, queue);
  return new Promise((resolve, reject) => {
    const cancel = () => {
      const index = queue.waiting.indexOf(start);
      if (index >= 0) queue.waiting.splice(index, 1);
      signal?.removeEventListener('abort', cancel);
      reject(new ProviderError('Provider request cancelled', 'cancellation'));
      if (!queue.active && !queue.waiting.length) queues.delete(endpoint);
    };
    const start = () => {
      signal?.removeEventListener('abort', cancel);
      if (signal?.aborted) { cancel(); return; }
      queue.active += 1;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        queue.active -= 1;
        while (queue.active < queue.limit && queue.waiting.length) queue.waiting.shift()!();
        if (!queue.active && !queue.waiting.length) queues.delete(endpoint);
      });
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (queue.active < queue.limit) start();
    else queue.waiting.push(start);
  });
}
