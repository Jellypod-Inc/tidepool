export interface TestSession {
  controller: AbortController;
  done: Promise<void>;
}

/**
 * Open an SSE session on a running daemon so the given agent name is
 * "registered" and inbound A2A can be routed to the supplied endpoint URL.
 *
 * Returns a handle with an AbortController to cancel the session when done.
 * Tests should `session.controller.abort()` in cleanup (e.g., afterEach).
 */
export async function registerTestSession(
  daemonLocalPort: number,
  name: string,
  endpointUrl: string,
  card: Record<string, unknown> = {},
): Promise<TestSession> {
  const controller = new AbortController();
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
        throw new Error(
          `registerTestSession(${name}): HTTP ${res.status}${body ? `: ${body}` : ""}`,
        );
      }
      // Drain the SSE events in the background so the session stays open
      const reader = res.body?.getReader();
      if (!reader) return;
      try {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
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

  // Give the daemon a moment to process the registration
  await new Promise((r) => setTimeout(r, 100));
  return { controller, done };
}
