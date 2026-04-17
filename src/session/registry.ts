import { randomUUID } from "node:crypto";
import type { AgentCardFragment, RegisteredSession } from "../types.js";

export type RegisterResult =
  | { ok: true; session: RegisteredSession }
  | { ok: false; reason: "conflict" };

export interface SessionRegistry {
  register(
    name: string,
    input: { endpoint: string; card: AgentCardFragment },
  ): RegisterResult;
  deregister(sessionId: string): void;
  get(name: string): RegisteredSession | undefined;
  list(): RegisteredSession[];
  onChange(cb: () => void): () => void;
}

export function createSessionRegistry(): SessionRegistry {
  const byName = new Map<string, RegisteredSession>();
  const bySessionId = new Map<string, string>();
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const cb of listeners) {
      try {
        cb();
      } catch {
        // listener errors are swallowed — registry must not fail on a bad consumer
      }
    }
  };

  return {
    register(name, input) {
      if (byName.has(name)) return { ok: false, reason: "conflict" };
      const session: RegisteredSession = {
        name,
        endpoint: input.endpoint,
        card: input.card,
        sessionId: randomUUID(),
        registeredAt: new Date(),
      };
      byName.set(name, session);
      bySessionId.set(session.sessionId, name);
      emit();
      return { ok: true, session };
    },
    deregister(sessionId) {
      const name = bySessionId.get(sessionId);
      if (!name) return;
      bySessionId.delete(sessionId);
      byName.delete(name);
      emit();
    },
    get(name) {
      return byName.get(name);
    },
    list() {
      return Array.from(byName.values());
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
