export interface TestSession {
  controller: AbortController;
  done: Promise<void>;
  sessionId: string;
}

/**
 * Open an SSE session on a running daemon so the given agent name is
 * "registered" and inbound A2A can be routed to the supplied endpoint URL.
 *
 * Returns a handle with an AbortController to cancel the session when done,
 * and the sessionId returned in the `session.registered` SSE event.
 * Tests should `session.controller.abort()` in cleanup (e.g., afterEach).
 */
export async function registerTestSession(
  daemonLocalPort: number,
  name: string,
  endpointUrl: string,
  card: Record<string, unknown> = {},
): Promise<TestSession> {
  const controller = new AbortController();
  let sessionId = "";
  let resolveReady: (id: string) => void;
  const ready = new Promise<string>((r) => { resolveReady = r; });

  const done = fetch(
    `http://127.0.0.1:${daemonLocalPort}/.well-known/tidepool/agents/${name}/session`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: endpointUrl, card }),
      signal: controller.signal,
    },
  )
    .then(async (res) => {
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`registerTestSession(${name}): HTTP ${res.status}${body ? `: ${body}` : ""}`);
      }
      const reader = res.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buf = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const lines = chunk.split("\n");
            let ev = "";
            let data = "";
            for (const ln of lines) {
              if (ln.startsWith("event: ")) ev = ln.slice(7).trim();
              else if (ln.startsWith("data: ")) data += ln.slice(6);
            }
            if (ev === "session.registered") {
              try {
                const parsed = JSON.parse(data);
                sessionId = parsed?.sessionId ?? "";
                resolveReady(sessionId);
              } catch {}
            }
          }
        }
      } catch {
        // Abort cascades here
      }
    })
    .catch((err) => {
      if ((err as { name?: string })?.name !== "AbortError") {
        process.stderr.write(`[test-helpers] session error for ${name}: ${String(err)}\n`);
      }
    });

  // Wait for session.registered or 2s timeout
  sessionId = await Promise.race([
    ready,
    new Promise<string>((r) => setTimeout(() => r(""), 2000)),
  ]);

  return { controller, done, sessionId };
}
