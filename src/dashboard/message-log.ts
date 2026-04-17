export interface ThreadSummary {
  contextId: string;
  participants: string[];
  messageCount: number;
  firstSeen: Date;
  lastActivity: Date;
}

interface ThreadEntry {
  contextId: string;
  participants: Set<string>;
  messageCount: number;
  firstSeen: Date;
  lastActivity: Date;
}

export interface RecordOpts {
  contextId: string | undefined;
  agent: string;
}

export class MessageLog {
  private threads = new Map<string, ThreadEntry>();
  private insertionOrder: string[] = [];

  constructor(private capacity: number) {}

  record(opts: RecordOpts): void {
    if (!opts.contextId) return;

    const existing = this.threads.get(opts.contextId);
    if (existing) {
      existing.participants.add(opts.agent);
      existing.messageCount++;
      existing.lastActivity = new Date();
      return;
    }

    // Evict oldest if at capacity
    if (this.threads.size >= this.capacity) {
      const oldest = this.insertionOrder.shift();
      if (oldest) this.threads.delete(oldest);
    }

    this.threads.set(opts.contextId, {
      contextId: opts.contextId,
      participants: new Set([opts.agent]),
      messageCount: 1,
      firstSeen: new Date(),
      lastActivity: new Date(),
    });
    this.insertionOrder.push(opts.contextId);
  }

  list(): ThreadSummary[] {
    return Array.from(this.threads.values())
      .sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime())
      .map((entry) => ({
        contextId: entry.contextId,
        participants: Array.from(entry.participants),
        messageCount: entry.messageCount,
        firstSeen: entry.firstSeen,
        lastActivity: entry.lastActivity,
      }));
  }
}
