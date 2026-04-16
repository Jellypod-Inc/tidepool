export type StoredMessage = {
  messageId: string;
  from: string;
  text: string;
  sentAt: number;
};

export type ThreadSummary = {
  contextId: string;
  peer: string;
  lastMessageAt: number;
  messageCount: number;
};

export type ThreadStoreOpts = {
  maxMessagesPerThread: number;
  maxThreads: number;
};

export type RecordArgs = {
  contextId: string;
  peer: string;
  messageId: string;
  from: string;
  text: string;
  sentAt: number;
};

type ThreadRecord = {
  peer: string;
  lastActivity: number;
  messages: StoredMessage[];
};

export type ThreadStore = {
  record(args: RecordArgs): void;
  listThreads(opts?: { peer?: string; limit?: number }): ThreadSummary[];
  history(contextId: string, opts?: { limit?: number }): StoredMessage[];
};

export function createThreadStore(opts: ThreadStoreOpts): ThreadStore {
  const threads = new Map<string, ThreadRecord>();

  function evictIfFull() {
    while (threads.size > opts.maxThreads) {
      let oldestKey: string | undefined;
      let oldestActivity = Infinity;
      for (const [k, v] of threads) {
        if (v.lastActivity < oldestActivity) {
          oldestActivity = v.lastActivity;
          oldestKey = k;
        }
      }
      if (oldestKey === undefined) break;
      threads.delete(oldestKey);
    }
  }

  return {
    record(args) {
      let t = threads.get(args.contextId);
      if (!t) {
        t = { peer: args.peer, lastActivity: args.sentAt, messages: [] };
        threads.set(args.contextId, t);
      }
      t.peer = args.peer;
      t.lastActivity = args.sentAt;
      t.messages.push({
        messageId: args.messageId,
        from: args.from,
        text: args.text,
        sentAt: args.sentAt,
      });
      if (t.messages.length > opts.maxMessagesPerThread) {
        t.messages.splice(0, t.messages.length - opts.maxMessagesPerThread);
      }
      evictIfFull();
    },

    listThreads(listOpts) {
      let summaries: ThreadSummary[] = [];
      for (const [contextId, t] of threads) {
        if (listOpts?.peer && t.peer !== listOpts.peer) continue;
        summaries.push({
          contextId,
          peer: t.peer,
          lastMessageAt: t.lastActivity,
          messageCount: t.messages.length,
        });
      }
      summaries.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
      if (listOpts?.limit !== undefined) {
        summaries = summaries.slice(0, listOpts.limit);
      }
      return summaries;
    },

    history(contextId, historyOpts) {
      const t = threads.get(contextId);
      if (!t) return [];
      const all = t.messages;
      if (historyOpts?.limit !== undefined) {
        return all.slice(-historyOpts.limit);
      }
      return [...all];
    },
  };
}
