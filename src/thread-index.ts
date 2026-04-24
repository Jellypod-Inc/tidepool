export interface ThreadIndexOptions {
  maxThreads: number;
  maxIdsPerThread: number;
}

export type Presence = "present" | "absent" | "unknown";

interface Bucket {
  ids: Set<string>;
  order: string[]; // FIFO within thread for per-thread id eviction
  lastSeen: number;
}

export class ThreadIndex {
  private threads = new Map<string, Bucket>();
  private counter = 0;

  constructor(private opts: ThreadIndexOptions) {}

  record(contextId: string, messageId: string): void {
    let bucket = this.threads.get(contextId);
    if (!bucket) {
      bucket = { ids: new Set(), order: [], lastSeen: ++this.counter };
      this.threads.set(contextId, bucket);
      this.evictThreadsIfNeeded();
    } else {
      bucket.lastSeen = ++this.counter;
    }
    if (!bucket.ids.has(messageId)) {
      bucket.ids.add(messageId);
      bucket.order.push(messageId);
      while (bucket.order.length > this.opts.maxIdsPerThread) {
        const removed = bucket.order.shift()!;
        bucket.ids.delete(removed);
      }
    }
  }

  has(contextId: string, messageId: string): Presence {
    const bucket = this.threads.get(contextId);
    if (!bucket) return "unknown";
    return bucket.ids.has(messageId) ? "present" : "absent";
  }

  private evictThreadsIfNeeded(): void {
    if (this.threads.size <= this.opts.maxThreads) return;
    const sorted = [...this.threads.entries()].sort(
      (a, b) => a[1].lastSeen - b[1].lastSeen,
    );
    while (this.threads.size > this.opts.maxThreads) {
      const [oldest] = sorted.shift()!;
      this.threads.delete(oldest);
    }
  }
}

/** Singleton factory. Callers who want a daemon-default index use this. */
export function createDefaultThreadIndex(): ThreadIndex {
  return new ThreadIndex({ maxThreads: 1024, maxIdsPerThread: 1024 });
}
