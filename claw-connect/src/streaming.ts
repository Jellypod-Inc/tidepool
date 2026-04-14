import type { Response as ExpressResponse } from "express";
import {
  formatSseEvent,
  parseSseLine,
  buildFailedStatusEvent,
} from "./a2a.js";

// Re-export the SSE primitives so callers that want them through this file
// keep working, but all new code should import directly from ./a2a.js.
export const formatSSEEvent = formatSseEvent;
export const parseSSELine = parseSseLine;

export function createTimeoutController(
  timeoutMs: number,
  onTimeout: () => void,
): { reset: () => void; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function start() {
    timer = setTimeout(onTimeout, timeoutMs);
  }

  function reset() {
    if (timer !== null) clearTimeout(timer);
    start();
  }

  function clear() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  start();
  return { reset, clear };
}

export function initSSEResponse(res: ExpressResponse): {
  write: (event: unknown) => void;
  end: () => void;
} {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  return {
    write: (event: unknown) => {
      res.write(formatSseEvent(event));
    },
    end: () => {
      if (!res.writableEnded) res.end();
    },
  };
}

export async function proxySSEStream(opts: {
  upstreamResponse: Response;
  downstream: ExpressResponse;
  timeoutMs: number;
  taskId: string;
  contextId: string;
}): Promise<void> {
  const { upstreamResponse, downstream, timeoutMs, taskId, contextId } = opts;

  const sse = initSSEResponse(downstream);
  let closed = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  let closeResolve: () => void = () => {};
  const closePromise = new Promise<{ done: true; value: undefined }>((resolve) => {
    closeResolve = () => resolve({ done: true, value: undefined });
  });

  const timeoutCtrl = createTimeoutController(timeoutMs, () => {
    if (closed) return;
    sse.write(
      buildFailedStatusEvent(
        taskId,
        contextId,
        "Stream timed out — no data received within timeout period",
      ),
    );
    cleanup();
  });

  function cleanup() {
    if (closed) return;
    closed = true;
    timeoutCtrl.clear();
    if (reader) {
      reader.cancel().catch(() => {});
    }
    sse.end();
    closeResolve();
  }

  downstream.on("close", () => cleanup());

  const body = upstreamResponse.body;
  if (!body) {
    sse.write(buildFailedStatusEvent(taskId, contextId, "Upstream returned no stream body"));
    cleanup();
    return;
  }

  reader = body.getReader();
  const activeReader = reader;
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (!closed) {
      const result = await Promise.race([activeReader.read(), closePromise]);
      if (result.done) break;

      timeoutCtrl.reset();

      buffer += decoder.decode(result.value as Uint8Array, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (closed) break;
        if (line.trim()) {
          downstream.write(line + "\n");
        } else {
          downstream.write("\n");
        }
      }
    }
  } catch {
    if (!closed) {
      sse.write(buildFailedStatusEvent(taskId, contextId, "Upstream stream broke unexpectedly"));
    }
  } finally {
    try {
      activeReader.releaseLock();
    } catch {}
    cleanup();
  }
}
