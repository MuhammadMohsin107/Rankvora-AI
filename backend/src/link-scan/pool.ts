/**
 * Work that has to be polite: a fixed number of requests in flight overall, and never more than a few to
 * any one website — a store's own host is the one most likely to be hit, and a blog full of links to the
 * same partner site must not become a flood to it.
 */

/** Runs `worker` over `items` with at most `limit` in flight, returning the results in order. Never rejects for a worker's sake: a thrown error becomes that item's result via `onError`. */
export async function pooled<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** A counting semaphore per key (a host name): `run(key, task)` waits until fewer than `perKey` tasks for that key are running. */
export class KeyedGate {
  private readonly active = new Map<string, number>();
  private readonly waiting = new Map<string, Array<() => void>>();

  constructor(private readonly perKey: number) {}

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    while ((this.active.get(key) ?? 0) >= this.perKey) {
      await new Promise<void>((resolve) => {
        const queue = this.waiting.get(key) ?? [];
        queue.push(resolve);
        this.waiting.set(key, queue);
      });
    }
    this.active.set(key, (this.active.get(key) ?? 0) + 1);
    try {
      return await task();
    } finally {
      this.active.set(key, (this.active.get(key) ?? 1) - 1);
      const next = this.waiting.get(key)?.shift();
      if (next) next();
    }
  }
}
