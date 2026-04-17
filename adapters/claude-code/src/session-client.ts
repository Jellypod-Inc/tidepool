export interface OpenSessionOpts {
  daemonUrl: string;
  name: string;
  endpoint: string;
  card: Record<string, unknown>;
  onError?: (err: Error) => void;
}

export interface SessionHandle {
  sessionId: string;
  close(): Promise<void>;
}

export async function openSession(
  opts: OpenSessionOpts,
): Promise<SessionHandle> {
  const controller = new AbortController();
  const url = `${opts.daemonUrl}/.well-known/tidepool/agents/${opts.name}/session`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ endpoint: opts.endpoint, card: opts.card }),
    signal: controller.signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `session registration failed: HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
    );
  }
  if (!res.body) throw new Error("session response has no body");

  let sessionId = "";
  let resolveReady: (id: string) => void;
  let rejectReady: (err: Error) => void;
  const ready = new Promise<string>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const readyTimeout = setTimeout(
    () => rejectReady(new Error("session.registered event not received within 3s")),
    3000,
  );

  // Start consuming the SSE stream in the background; resolve `ready` on first
  // session.registered event. Other events (e.g. future extensions) are ignored.
  const consume = async () => {
    const reader = res.body!.getReader();
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
            // comment lines (":") are ignored
          }
          if (!ev) continue;
          try {
            const parsed = data ? JSON.parse(data) : null;
            if (ev === "session.registered") {
              sessionId = parsed?.sessionId ?? "";
              clearTimeout(readyTimeout);
              resolveReady(sessionId);
            }
          } catch (e) {
            opts.onError?.(e instanceof Error ? e : new Error(String(e)));
          }
        }
      }
    } catch (e) {
      if ((e as { name?: string })?.name !== "AbortError") {
        opts.onError?.(e instanceof Error ? e : new Error(String(e)));
      }
    }
  };

  void consume();
  await ready;

  return {
    sessionId,
    close: async () => {
      controller.abort();
    },
  };
}
