import type { Response as ExpressResponse } from "express";
import {
  formatSseEvent,
  parseSseLine,
  buildFailedStatusEvent,
  StreamEventSchema,
} from "./a2a.js";
import {
  validateWire,
  logWireFailure,
  type ValidationMode,
} from "./wire-validation.js";

const truncate = (s: string, n: number): string =>
  s.length > n ? s.slice(0, n) + "…" : s;

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

/**
 * Proxy an upstream SSE response to a downstream Express response. If the
 * upstream isn't a valid stream, emits a single failed status-update and ends
 * the response without attempting to proxy.
 */
export async function proxyUpstreamOrFail(opts: {
  upstreamResponse: Response;
  downstream: ExpressResponse;
  timeoutMs: number;
  taskId: string;
  validationMode: ValidationMode;
  /** Human-readable message emitted if upstream is non-streaming. */
  nonStreamingMessage?: string;
}): Promise<void> {
  const {
    upstreamResponse,
    downstream,
    timeoutMs,
    taskId,
    validationMode,
    nonStreamingMessage = "Agent returned non-streaming response",
  } = opts;

  const contextId = `ctx-${taskId}`;

  if (!upstreamResponse.ok || !upstreamResponse.body) {
    const sse = initSSEResponse(downstream);
    sse.write(buildFailedStatusEvent(taskId, contextId, nonStreamingMessage));
    sse.end();
    return;
  }

  await proxySSEStream({
    upstreamResponse,
    downstream,
    timeoutMs,
    taskId,
    contextId,
    validationMode,
  });
}

export async function proxySSEStream(opts: {
  upstreamResponse: Response;
  downstream: ExpressResponse;
  timeoutMs: number;
  taskId: string;
  contextId: string;
  validationMode: ValidationMode;
}): Promise<void> {
  const { upstreamResponse, downstream, timeoutMs, taskId, contextId, validationMode } = opts;

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
        if (!line.trim()) {
          downstream.write("\n");
          continue;
        }

        const parsed = parseSseLine(line);

        if (parsed.kind === "skip") {
          // Comments, `event:` headers, and other non-data lines pass through
          // untouched — they carry no JSON payload to validate.
          downstream.write(line + "\n");
          continue;
        }

        if (parsed.kind === "invalid-json") {
          // A `data:` line whose JSON.parse threw. In warn mode we log but
          // pass the raw line through (downstream SSE consumers will discard
          // unparseable data frames themselves). In enforce mode we reject —
          // otherwise malformed JSON would slip past schema validation.
          logWireFailure(
            validationMode,
            "upstream.sse.event",
            `invalid JSON: ${truncate(parsed.raw, 80)}`,
          );
          if (validationMode === "enforce") {
            sse.write(
              buildFailedStatusEvent(
                taskId,
                contextId,
                `Upstream sent unparseable SSE data: ${truncate(parsed.raw, 80)}`,
              ),
            );
            cleanup();
            return;
          }
          downstream.write(line + "\n");
          continue;
        }

        // parsed.kind === "data" — schema-validate against StreamEventSchema.
        // In warn mode, validateWire logs and returns ok; in enforce mode,
        // we emit a failed status-update downstream and tear the stream down.
        const result = validateWire(StreamEventSchema, parsed.value, {
          mode: validationMode,
          context: "upstream.sse.event",
        });
        if (!result.ok) {
          sse.write(
            buildFailedStatusEvent(
              taskId,
              contextId,
              `Upstream sent malformed event: ${result.error}`,
            ),
          );
          cleanup();
          return;
        }

        downstream.write(line + "\n");
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
