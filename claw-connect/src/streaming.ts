import type { Response as ExpressResponse } from "express";
import type { TaskStatusUpdateEvent } from "./types.js";

export function formatSSEEvent(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export function parseSSELine(line: string): unknown | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":") || !trimmed.startsWith("data: ")) {
    return null;
  }

  const jsonStr = trimmed.slice(6);
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

export function buildFailedEvent(
  taskId: string,
  contextId: string,
  reason: string,
): TaskStatusUpdateEvent {
  return {
    kind: "status-update",
    taskId,
    contextId,
    status: {
      state: "TASK_STATE_FAILED",
      timestamp: new Date().toISOString(),
      message: {
        role: "ROLE_AGENT",
        parts: [{ kind: "text", text: reason }],
      },
    },
    final: true,
  };
}

export function createTimeoutController(
  timeoutMs: number,
  onTimeout: () => void,
): { reset: () => void; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function start() {
    timer = setTimeout(onTimeout, timeoutMs);
  }

  function reset() {
    if (timer !== null) {
      clearTimeout(timer);
    }
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
      res.write(formatSSEEvent(event));
    },
    end: () => {
      if (!res.writableEnded) {
        res.end();
      }
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

  // Promise that resolves when closing — used to interrupt a blocked reader.read()
  // via Promise.race. Without this, a hung upstream would keep the read pending
  // even after we call reader.cancel().
  let closeResolve: () => void = () => {};
  const closePromise = new Promise<{ done: true; value: undefined }>(
    (resolve) => {
      closeResolve = () => resolve({ done: true, value: undefined });
    },
  );

  const timeoutCtrl = createTimeoutController(timeoutMs, () => {
    if (closed) return;
    const failEvent = buildFailedEvent(taskId, contextId, "Stream timed out — no data received within timeout period");
    sse.write(failEvent);
    cleanup();
  });

  function cleanup() {
    if (closed) return;
    closed = true;
    timeoutCtrl.clear();
    if (reader) {
      reader.cancel().catch(() => {
        // ignore cancellation errors
      });
    }
    sse.end();
    closeResolve();
  }

  downstream.on("close", () => {
    cleanup();
  });

  const body = upstreamResponse.body;
  if (!body) {
    const failEvent = buildFailedEvent(taskId, contextId, "Upstream returned no stream body");
    sse.write(failEvent);
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
      const failEvent = buildFailedEvent(taskId, contextId, "Upstream stream broke unexpectedly");
      sse.write(failEvent);
    }
  } finally {
    try {
      activeReader.releaseLock();
    } catch {
      // already released
    }
    cleanup();
  }
}
