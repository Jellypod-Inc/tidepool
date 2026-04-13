# Claw Connect Phase 5: Streaming and Polish

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Long-running requests stream properly via SSE, CLI is complete, Agent Card synthesis is rich and correct. Production-ready for real use.

**Architecture:** SSE streams are proxied transparently in both directions. Claw Connect never buffers, transforms, or adds to stream chunks. On the local interface, a local agent sends `SendStreamingMessage` and Claw Connect opens an SSE connection to the remote peer over mTLS, piping events back. On the public interface, a remote peer sends `SendStreamingMessage` and Claw Connect opens an SSE connection to the local agent, piping events back. If `timeout_seconds` passes with no data on either side, Claw Connect sends `TASK_STATE_FAILED` and closes both ends. If either side disconnects, the other side is cleaned up.

**Tech Stack:** Same as previous phases. New dependency: `eventsource-parser` (for parsing SSE streams from upstream).

**Spec:** `docs/superpowers/specs/2026-04-13-claw-connect-revised-design.md`

**Depends on:** Phases 1-4 complete (server, friends, rate limiting, discovery all working).

---

## File Structure

```
claw-connect/
├── src/
│   ├── streaming.ts              # SSE proxy logic — pipe, timeout, cleanup
│   ├── agent-card.ts             # MODIFIED — rich Agent Card synthesis from remote cards
│   ├── server.ts                 # MODIFIED — add streaming routes + status/ping CLI endpoints
│   └── types.ts                  # MODIFIED — add streaming types
├── bin/
│   └── cli.ts                    # MODIFIED — add status and ping commands
├── test/
│   ├── streaming.test.ts         # SSE proxy unit tests
│   ├── streaming-e2e.test.ts     # End-to-end streaming through two servers
│   ├── agent-card-rich.test.ts   # Rich Agent Card synthesis tests
│   ├── cli-status.test.ts        # Status command tests
│   └── cli-ping.test.ts          # Ping command tests
```

---

### Task 1: Streaming Types and SSE Utilities

**Files:**
- Modify: `claw-connect/src/types.ts`
- Create: `claw-connect/src/streaming.ts`
- Create: `claw-connect/test/streaming.test.ts`

- [ ] **Step 1: Add streaming types to types.ts**

Add to the end of `claw-connect/src/types.ts`:

```typescript
export interface TaskStatusUpdateEvent {
  kind: "status-update";
  taskId: string;
  contextId: string;
  status: {
    state: string;
    timestamp?: string;
    message?: { role: string; parts: { kind: string; text: string }[] };
  };
  final: boolean;
}

export interface TaskArtifactUpdateEvent {
  kind: "artifact-update";
  taskId: string;
  contextId: string;
  artifact: {
    artifactId: string;
    parts: { kind: string; text: string }[];
  };
}

export type StreamEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

export interface StreamTimeoutOptions {
  timeoutMs: number;
  taskId: string;
  contextId: string;
}
```

- [ ] **Step 2: Write the failing test**

Create `claw-connect/test/streaming.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import http from "http";
import express from "express";
import {
  buildFailedEvent,
  createTimeoutController,
  formatSSEEvent,
  parseSSELine,
} from "../src/streaming.js";

describe("formatSSEEvent", () => {
  it("formats a JSON object as an SSE data line", () => {
    const event = { kind: "status-update", taskId: "t1" };
    const result = formatSSEEvent(event);
    expect(result).toBe(`data: ${JSON.stringify(event)}\n\n`);
  });
});

describe("parseSSELine", () => {
  it("parses a data: prefixed line into a JSON object", () => {
    const obj = { kind: "status-update", taskId: "t1" };
    const line = `data: ${JSON.stringify(obj)}`;
    const result = parseSSELine(line);
    expect(result).toEqual(obj);
  });

  it("returns null for empty lines", () => {
    expect(parseSSELine("")).toBeNull();
    expect(parseSSELine("\n")).toBeNull();
  });

  it("returns null for comment lines", () => {
    expect(parseSSELine(": keepalive")).toBeNull();
  });

  it("returns null for non-data lines", () => {
    expect(parseSSELine("event: update")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseSSELine("data: {not json")).toBeNull();
  });
});

describe("buildFailedEvent", () => {
  it("builds a TASK_STATE_FAILED status update event", () => {
    const event = buildFailedEvent("task-1", "ctx-1", "Stream timed out");
    expect(event.kind).toBe("status-update");
    expect(event.taskId).toBe("task-1");
    expect(event.contextId).toBe("ctx-1");
    expect(event.status.state).toBe("TASK_STATE_FAILED");
    expect(event.status.message?.parts[0].text).toBe("Stream timed out");
    expect(event.final).toBe(true);
  });
});

describe("createTimeoutController", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls onTimeout after the specified duration with no reset", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();

    const controller = createTimeoutController(5000, onTimeout);

    vi.advanceTimersByTime(4999);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledOnce();

    controller.clear();
  });

  it("does not fire if reset is called before timeout", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();

    const controller = createTimeoutController(5000, onTimeout);

    vi.advanceTimersByTime(3000);
    controller.reset();

    vi.advanceTimersByTime(4999);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledOnce();

    controller.clear();
  });

  it("does not fire after clear", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();

    const controller = createTimeoutController(5000, onTimeout);
    controller.clear();

    vi.advanceTimersByTime(10000);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd claw-connect && pnpm test -- test/streaming.test.ts`
Expected: FAIL — `Cannot find module '../src/streaming.js'`

- [ ] **Step 4: Write the implementation**

Create `claw-connect/src/streaming.ts`:

```typescript
import type { Response as ExpressResponse, Request as ExpressRequest } from "express";
import type { TaskStatusUpdateEvent, StreamEvent } from "./types.js";

/**
 * Format a JSON object as an SSE `data:` line.
 */
export function formatSSEEvent(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/**
 * Parse a single SSE line. Returns the parsed JSON for `data:` lines,
 * or null for anything else (comments, empty lines, event/id lines, bad JSON).
 */
export function parseSSELine(line: string): unknown | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":") || !trimmed.startsWith("data: ")) {
    return null;
  }

  const jsonStr = trimmed.slice(6); // strip "data: "
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

/**
 * Build a TASK_STATE_FAILED event for stream errors or timeouts.
 */
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

/**
 * Create a resettable timeout controller. Each time data arrives,
 * call `reset()` to restart the countdown. If the timeout fires,
 * `onTimeout` is called exactly once.
 */
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

/**
 * Initialize an SSE response — sets headers, flushes them, and returns
 * a write helper. Call `end()` when the stream is done.
 */
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

/**
 * Proxy an SSE stream from an upstream Response (fetch) to a downstream
 * Express response. Handles timeout, broken connections, and cleanup.
 *
 * - `upstreamResponse`: the fetch Response from the upstream agent
 * - `downstream`: the Express response to the requesting agent
 * - `timeoutMs`: max milliseconds between chunks before TASK_STATE_FAILED
 * - `taskId` / `contextId`: used for the failure event if timeout fires
 */
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

  function cleanup() {
    if (closed) return;
    closed = true;
    timeout.clear();
    sse.end();
  }

  const timeout = createTimeoutController(timeoutMs, () => {
    if (closed) return;
    const failEvent = buildFailedEvent(taskId, contextId, "Stream timed out — no data received within timeout period");
    sse.write(failEvent);
    cleanup();
  });

  // If the downstream client disconnects, clean up
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

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (!closed) {
      const { done, value } = await reader.read();
      if (done) break;

      timeout.reset();

      // Decode chunk and split into lines
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // Keep the last incomplete line in the buffer
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (closed) break;
        // Pass through the raw SSE line — we don't transform
        if (line.trim()) {
          downstream.write(line + "\n");
        } else {
          // Empty line = event boundary in SSE
          downstream.write("\n");
        }
      }
    }
  } catch (err) {
    if (!closed) {
      const failEvent = buildFailedEvent(taskId, contextId, "Upstream stream broke unexpectedly");
      sse.write(failEvent);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
    cleanup();
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd claw-connect && pnpm test -- test/streaming.test.ts`
Expected: 8 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add claw-connect/src/streaming.ts claw-connect/src/types.ts claw-connect/test/streaming.test.ts
git commit -m "feat(claw-connect): SSE streaming utilities — format, parse, timeout, proxy"
```

---

### Task 2: Streaming Routes on Public and Local Interfaces

**Files:**
- Modify: `claw-connect/src/server.ts`
- Create: `claw-connect/test/streaming-e2e.test.ts`

- [ ] **Step 1: Write the failing e2e streaming test**

Create `claw-connect/test/streaming-e2e.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import express from "express";
import TOML from "@iarna/toml";
import { generateIdentity } from "../src/identity.js";
import { startServer } from "../src/server.js";
import { formatSSEEvent } from "../src/streaming.js";

/**
 * Mock A2A agent that supports SendStreamingMessage.
 * Streams three events then closes.
 */
function createStreamingMockAgent(port: number, name: string): http.Server {
  const app = express();
  app.use(express.json());

  // Standard message:send (non-streaming)
  app.post("/message\\:send", (req, res) => {
    const userMessage = req.body?.message?.parts?.[0]?.text ?? "no message";
    res.json({
      id: `task-${name}`,
      contextId: `ctx-${name}`,
      status: { state: "TASK_STATE_COMPLETED" },
      artifacts: [
        {
          artifactId: "response",
          parts: [{ kind: "text", text: `${name} received: ${userMessage}` }],
        },
      ],
    });
  });

  // Streaming message:sendStream
  app.post("/message\\:stream", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const taskId = `task-stream-${name}`;
    const contextId = `ctx-stream-${name}`;

    // Event 1: working
    res.write(
      formatSSEEvent({
        kind: "status-update",
        taskId,
        contextId,
        status: { state: "TASK_STATE_WORKING" },
        final: false,
      }),
    );

    // Event 2: artifact
    setTimeout(() => {
      res.write(
        formatSSEEvent({
          kind: "artifact-update",
          taskId,
          contextId,
          artifact: {
            artifactId: "chunk-1",
            parts: [{ kind: "text", text: `Hello from ${name}` }],
          },
        }),
      );
    }, 50);

    // Event 3: completed
    setTimeout(() => {
      res.write(
        formatSSEEvent({
          kind: "status-update",
          taskId,
          contextId,
          status: { state: "TASK_STATE_COMPLETED" },
          final: true,
        }),
      );
      res.end();
    }, 100);
  });

  return app.listen(port, "127.0.0.1");
}

/**
 * Mock agent that hangs (never sends data) to test timeout.
 */
function createHangingMockAgent(port: number): http.Server {
  const app = express();
  app.use(express.json());

  app.post("/message\\:stream", (_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // Never write anything — the stream hangs.
  });

  return app.listen(port, "127.0.0.1");
}

/**
 * Collect all SSE events from a fetch response.
 */
async function collectSSEEvents(response: Response): Promise<unknown[]> {
  const events: unknown[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data: ")) {
        try {
          events.push(JSON.parse(trimmed.slice(6)));
        } catch {
          // skip malformed
        }
      }
    }
  }

  return events;
}

describe("e2e: SSE streaming through two Claw Connect servers", () => {
  let tmpDir: string;
  let aliceConfigDir: string;
  let bobConfigDir: string;
  let aliceMockAgent: http.Server;
  let bobMockAgent: http.Server;
  let aliceServer: { close: () => void };
  let bobServer: { close: () => void };

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-stream-e2e-"));

    // --- Alice's setup ---
    aliceConfigDir = path.join(tmpDir, "alice");
    fs.mkdirSync(path.join(aliceConfigDir, "agents/alice-dev"), {
      recursive: true,
    });

    const aliceIdentity = await generateIdentity({
      name: "alice-dev",
      certPath: path.join(aliceConfigDir, "agents/alice-dev/identity.crt"),
      keyPath: path.join(aliceConfigDir, "agents/alice-dev/identity.key"),
    });

    // --- Bob's setup ---
    bobConfigDir = path.join(tmpDir, "bob");
    fs.mkdirSync(path.join(bobConfigDir, "agents/rust-expert"), {
      recursive: true,
    });

    const bobIdentity = await generateIdentity({
      name: "rust-expert",
      certPath: path.join(bobConfigDir, "agents/rust-expert/identity.crt"),
      keyPath: path.join(bobConfigDir, "agents/rust-expert/identity.key"),
    });

    // --- Alice's config ---
    fs.writeFileSync(
      path.join(aliceConfigDir, "server.toml"),
      TOML.stringify({
        server: {
          port: 19910,
          host: "0.0.0.0",
          localPort: 19911,
          rateLimit: "100/hour",
          streamTimeoutSeconds: 30,
        },
        agents: {
          "alice-dev": {
            localEndpoint: "http://127.0.0.1:28810",
            rateLimit: "50/hour",
            description: "Alice's dev agent",
          },
        },
        connectionRequests: { mode: "deny" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      } as any),
    );

    fs.writeFileSync(
      path.join(aliceConfigDir, "friends.toml"),
      TOML.stringify({
        friends: {
          "bobs-rust-expert": { fingerprint: bobIdentity.fingerprint },
        },
      } as any),
    );

    // --- Bob's config ---
    fs.writeFileSync(
      path.join(bobConfigDir, "server.toml"),
      TOML.stringify({
        server: {
          port: 29910,
          host: "0.0.0.0",
          localPort: 29911,
          rateLimit: "100/hour",
          streamTimeoutSeconds: 30,
        },
        agents: {
          "rust-expert": {
            localEndpoint: "http://127.0.0.1:38810",
            rateLimit: "50/hour",
            description: "Bob's Rust expert",
          },
        },
        connectionRequests: { mode: "deny" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      } as any),
    );

    fs.writeFileSync(
      path.join(bobConfigDir, "friends.toml"),
      TOML.stringify({
        friends: {
          "alices-dev": { fingerprint: aliceIdentity.fingerprint },
        },
      } as any),
    );

    // --- Start mock agents ---
    aliceMockAgent = createStreamingMockAgent(28810, "alice-dev");
    bobMockAgent = createStreamingMockAgent(38810, "rust-expert");

    // --- Start Claw Connect servers ---
    aliceServer = await startServer({
      configDir: aliceConfigDir,
      remoteAgents: [
        {
          localHandle: "bobs-rust",
          remoteEndpoint: "https://127.0.0.1:29910",
          remoteTenant: "rust-expert",
          certFingerprint: bobIdentity.fingerprint,
        },
      ],
    });

    bobServer = await startServer({
      configDir: bobConfigDir,
      remoteAgents: [
        {
          localHandle: "alices-dev",
          remoteEndpoint: "https://127.0.0.1:19910",
          remoteTenant: "alice-dev",
          certFingerprint: aliceIdentity.fingerprint,
        },
      ],
    });
  });

  afterAll(() => {
    aliceMockAgent?.close();
    bobMockAgent?.close();
    aliceServer?.close();
    bobServer?.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("streams SSE events from Bob's agent through both servers to Alice's local interface", async () => {
    const response = await fetch(
      "http://127.0.0.1:19911/bobs-rust/message:stream",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            messageId: "stream-test-1",
            role: "ROLE_USER",
            parts: [{ kind: "text", text: "Stream me a response" }],
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events = await collectSSEEvents(response);

    // Should have at least 3 events: working, artifact, completed
    expect(events.length).toBeGreaterThanOrEqual(3);

    const statusEvents = events.filter(
      (e: any) => e.kind === "status-update",
    );
    const artifactEvents = events.filter(
      (e: any) => e.kind === "artifact-update",
    );

    expect(statusEvents.length).toBeGreaterThanOrEqual(2);
    expect(artifactEvents.length).toBeGreaterThanOrEqual(1);

    // First status should be working
    expect((statusEvents[0] as any).status.state).toBe("TASK_STATE_WORKING");
    // Last status should be completed
    expect((statusEvents[statusEvents.length - 1] as any).status.state).toBe(
      "TASK_STATE_COMPLETED",
    );

    // Artifact should contain the mock agent's response
    expect((artifactEvents[0] as any).artifact.parts[0].text).toContain(
      "Hello from rust-expert",
    );
  });

  it("streams SSE events for inbound requests on the public interface", async () => {
    // Bob's agent streams a response to Alice's request via the public interface.
    // This test hits Bob's local interface for a local agent stream, verifying
    // the local-to-local streaming path works.
    const response = await fetch(
      "http://127.0.0.1:29911/rust-expert/message:stream",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            messageId: "stream-test-2",
            role: "ROLE_USER",
            parts: [{ kind: "text", text: "Stream locally" }],
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    const events = await collectSSEEvents(response);
    expect(events.length).toBeGreaterThanOrEqual(3);
  });
});

describe("e2e: SSE stream timeout", () => {
  let tmpDir: string;
  let configDir: string;
  let hangingAgent: http.Server;
  let server: { close: () => void };

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-stream-timeout-"));
    configDir = path.join(tmpDir, "timeout-server");
    fs.mkdirSync(path.join(configDir, "agents/slow-agent"), {
      recursive: true,
    });

    await generateIdentity({
      name: "slow-agent",
      certPath: path.join(configDir, "agents/slow-agent/identity.crt"),
      keyPath: path.join(configDir, "agents/slow-agent/identity.key"),
    });

    fs.writeFileSync(
      path.join(configDir, "server.toml"),
      TOML.stringify({
        server: {
          port: 19920,
          host: "0.0.0.0",
          localPort: 19921,
          rateLimit: "100/hour",
          streamTimeoutSeconds: 1, // 1 second for fast testing
        },
        agents: {
          "slow-agent": {
            localEndpoint: "http://127.0.0.1:28820",
            rateLimit: "50/hour",
            description: "A slow agent that hangs",
          },
        },
        connectionRequests: { mode: "deny" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      } as any),
    );

    fs.writeFileSync(
      path.join(configDir, "friends.toml"),
      TOML.stringify({ friends: {} } as any),
    );

    hangingAgent = createHangingMockAgent(28820);

    server = await startServer({ configDir });
  });

  afterAll(() => {
    hangingAgent?.close();
    server?.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("sends TASK_STATE_FAILED when stream times out with no data", async () => {
    const response = await fetch(
      "http://127.0.0.1:19921/slow-agent/message:stream",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            messageId: "timeout-test-1",
            role: "ROLE_USER",
            parts: [{ kind: "text", text: "Hello slow agent" }],
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events = await collectSSEEvents(response);

    // Should contain a TASK_STATE_FAILED event
    const failEvents = events.filter(
      (e: any) => e.kind === "status-update" && e.status?.state === "TASK_STATE_FAILED",
    );
    expect(failEvents.length).toBe(1);
    expect((failEvents[0] as any).final).toBe(true);
  }, 10000); // Allow extra time for the timeout
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd claw-connect && pnpm test -- test/streaming-e2e.test.ts`
Expected: FAIL — streaming routes do not exist yet in `server.ts`.

- [ ] **Step 3: Add `streamTimeoutSeconds` to ServerConfig in types.ts**

Add to the `server` field inside `ServerConfig` in `claw-connect/src/types.ts`:

```typescript
export interface ServerConfig {
  server: {
    port: number;
    host: string;
    localPort: number;
    rateLimit: string;
    streamTimeoutSeconds: number;
  };
  agents: Record<string, AgentConfig>;
  connectionRequests: {
    mode: "accept" | "deny" | "auto";
  };
  discovery: {
    providers: string[];
    cacheTtlSeconds: number;
  };
}
```

- [ ] **Step 4: Update config.ts to parse streamTimeoutSeconds**

In `claw-connect/src/config.ts`, inside `loadServerConfig`, update the `server` block:

```typescript
    server: {
      port: (server.port as number) ?? 9900,
      host: (server.host as string) ?? "0.0.0.0",
      localPort: (server.localPort as number) ?? 9901,
      rateLimit: (server.rateLimit as string) ?? "100/hour",
      streamTimeoutSeconds: (server.streamTimeoutSeconds as number) ?? 300,
    },
```

- [ ] **Step 5: Add streaming routes to server.ts**

In `claw-connect/src/server.ts`, add the import at the top:

```typescript
import { proxySSEStream, buildFailedEvent, initSSEResponse } from "./streaming.js";
```

In the `createPublicApp` function, add a streaming route BEFORE the existing `/:tenant/*` route:

```typescript
  // Streaming endpoint per tenant (public interface — inbound)
  app.post(
    "/:tenant/message\\:stream",
    async (req, res) => {
      const { tenant } = req.params;

      // 1. Extract peer cert fingerprint
      const peerCert = (req.socket as any).getPeerCertificate?.();
      if (!peerCert || !peerCert.raw) {
        res.status(401).json({ error: "No client certificate" });
        return;
      }

      const peerFingerprint = getFingerprint(
        `-----BEGIN CERTIFICATE-----\n${peerCert.raw.toString("base64")}\n-----END CERTIFICATE-----`,
      );

      // 2. Check friends list
      const friendLookup = checkFriend(friends, peerFingerprint);
      if (!friendLookup) {
        res.status(401).json({ error: "Not a friend" });
        return;
      }

      // 3. Resolve tenant
      const agent = resolveTenant(config, tenant);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      // 4. Check agent scope
      if (!checkAgentScope(friendLookup.friend, tenant)) {
        res.status(403).json({ error: "Not authorized for this agent" });
        return;
      }

      // 5. Forward streaming request to local agent
      const targetUrl = `${agent.localEndpoint}/message:stream`;
      const timeoutMs = config.server.streamTimeoutSeconds * 1000;

      try {
        const upstreamResponse = await fetch(targetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(req.body),
        });

        if (!upstreamResponse.ok || !upstreamResponse.body) {
          const taskId = req.body?.message?.messageId ?? uuidv4();
          const sse = initSSEResponse(res);
          sse.write(buildFailedEvent(taskId, `ctx-${taskId}`, "Agent returned non-streaming response"));
          sse.end();
          return;
        }

        const taskId = req.body?.message?.messageId ?? uuidv4();
        await proxySSEStream({
          upstreamResponse,
          downstream: res,
          timeoutMs,
          taskId,
          contextId: `ctx-${taskId}`,
        });
      } catch (err) {
        if (!res.headersSent) {
          res.status(504).json({
            id: uuidv4(),
            status: { state: "TASK_STATE_FAILED" },
            artifacts: [
              {
                artifactId: "error",
                parts: [{ kind: "text", text: "Agent unreachable" }],
              },
            ],
          });
        }
      }
    },
  );
```

In the `createLocalApp` function, add a streaming route for outbound (remote agents) and local agents BEFORE the existing `/:tenant/*` route:

```typescript
  // Streaming endpoint — outbound to remote or local agent
  app.post("/:tenant/message\\:stream", async (req, res) => {
    const { tenant } = req.params;
    const timeoutMs = config.server.streamTimeoutSeconds * 1000;
    const taskId = req.body?.message?.messageId ?? uuidv4();

    const remote = mapLocalTenantToRemote(remoteAgents, tenant);

    if (!remote) {
      // Try local agent
      const agent = config.agents[tenant];
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      // Stream from local agent
      const targetUrl = `${agent.localEndpoint}/message:stream`;
      try {
        const upstreamResponse = await fetch(targetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(req.body),
        });

        if (!upstreamResponse.ok || !upstreamResponse.body) {
          const sse = initSSEResponse(res);
          sse.write(buildFailedEvent(taskId, `ctx-${taskId}`, "Agent returned non-streaming response"));
          sse.end();
          return;
        }

        await proxySSEStream({
          upstreamResponse,
          downstream: res,
          timeoutMs,
          taskId,
          contextId: `ctx-${taskId}`,
        });
      } catch {
        if (!res.headersSent) {
          res.status(504).json({ error: "Local agent unreachable" });
        }
      }
      return;
    }

    // Outbound to remote agent via mTLS
    const targetUrl = buildOutboundUrl(
      remote.remoteEndpoint,
      remote.remoteTenant,
      "/message:stream",
    );

    const firstAgent = Object.keys(config.agents)[0];
    const certPath = `${process.env.CC_CONFIG_DIR ?? "~/.claw-connect"}/agents/${firstAgent}/identity.crt`;
    const keyPath = `${process.env.CC_CONFIG_DIR ?? "~/.claw-connect"}/agents/${firstAgent}/identity.key`;

    try {
      const response = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body),
        // @ts-expect-error — Node fetch supports dispatcher for custom TLS
        dispatcher: new (await import("undici")).Agent({
          connect: {
            cert: fs.readFileSync(certPath),
            key: fs.readFileSync(keyPath),
            rejectUnauthorized: false,
          },
        }),
      });

      if (!response.ok || !response.body) {
        const sse = initSSEResponse(res);
        sse.write(buildFailedEvent(taskId, `ctx-${taskId}`, "Remote agent returned non-streaming response"));
        sse.end();
        return;
      }

      await proxySSEStream({
        upstreamResponse: response,
        downstream: res,
        timeoutMs,
        taskId,
        contextId: `ctx-${taskId}`,
      });
    } catch (err) {
      if (!res.headersSent) {
        const sse = initSSEResponse(res);
        sse.write(buildFailedEvent(taskId, `ctx-${taskId}`, "Remote agent unreachable"));
        sse.end();
      }
    }
  });
```

- [ ] **Step 6: Run the streaming e2e test**

Run: `cd claw-connect && pnpm test -- test/streaming-e2e.test.ts`
Expected: All 3 tests PASS. If there are port conflicts, adjust ports and re-run.

- [ ] **Step 7: Run full test suite**

Run: `cd claw-connect && pnpm test`
Expected: All existing tests still PASS plus the new streaming tests.

- [ ] **Step 8: Commit**

```bash
git add claw-connect/src/server.ts claw-connect/src/config.ts claw-connect/src/types.ts claw-connect/test/streaming-e2e.test.ts
git commit -m "feat(claw-connect): SSE stream passthrough for SendStreamingMessage with timeout"
```

---

### Task 3: Rich Agent Card Synthesis

**Files:**
- Modify: `claw-connect/src/agent-card.ts`
- Create: `claw-connect/test/agent-card-rich.test.ts`

Currently, `buildRemoteAgentCard` uses a placeholder description. This task fetches the remote agent's actual Agent Card and uses its skills, description, input/output modes, and capabilities.

- [ ] **Step 1: Write the failing test**

Create `claw-connect/test/agent-card-rich.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import express from "express";
import {
  fetchRemoteAgentCard,
  buildRichRemoteAgentCard,
} from "../src/agent-card.js";
import type { RemoteAgent } from "../src/types.js";

// Mock remote Agent Card server
let mockServer: http.Server;
const mockPort = 48900;

const mockRemoteCard = {
  name: "rust-expert",
  description: "Deep expertise in Rust ownership, lifetimes, and async patterns",
  url: "https://bob.example.com:9900/rust-expert",
  version: "2.1.0",
  skills: [
    {
      id: "ownership-help",
      name: "Ownership Help",
      description: "Explains Rust ownership and borrowing",
      tags: ["rust", "ownership", "borrowing"],
    },
    {
      id: "async-patterns",
      name: "Async Patterns",
      description: "Async/await patterns in Rust",
      tags: ["rust", "async", "tokio"],
    },
  ],
  defaultInputModes: ["text/plain", "application/json"],
  defaultOutputModes: ["text/plain", "text/markdown"],
  capabilities: {
    streaming: true,
    pushNotifications: false,
    stateTransitionHistory: true,
  },
  securitySchemes: {
    mtls: {
      mutualTlsSecurityScheme: {
        description: "mTLS with self-signed certificates",
      },
    },
  },
  securityRequirements: [{ mtls: [] }],
};

beforeAll(() => {
  const app = express();

  app.get("/rust-expert/.well-known/agent-card.json", (_req, res) => {
    res.json(mockRemoteCard);
  });

  mockServer = app.listen(mockPort, "127.0.0.1");
});

afterAll(() => {
  mockServer?.close();
});

describe("fetchRemoteAgentCard", () => {
  it("fetches and returns an Agent Card from a URL", async () => {
    const card = await fetchRemoteAgentCard(
      `http://127.0.0.1:${mockPort}/rust-expert/.well-known/agent-card.json`,
    );

    expect(card).not.toBeNull();
    expect(card!.name).toBe("rust-expert");
    expect(card!.description).toContain("Rust ownership");
    expect(card!.skills).toHaveLength(2);
    expect(card!.skills[0].id).toBe("ownership-help");
  });

  it("returns null for unreachable URLs", async () => {
    const card = await fetchRemoteAgentCard(
      "http://127.0.0.1:59999/nonexistent/.well-known/agent-card.json",
    );
    expect(card).toBeNull();
  });

  it("returns null for non-JSON responses", async () => {
    // The mock server only has one route; hitting a different path returns 404
    const card = await fetchRemoteAgentCard(
      `http://127.0.0.1:${mockPort}/bad-path`,
    );
    expect(card).toBeNull();
  });
});

describe("buildRichRemoteAgentCard", () => {
  it("uses remote card skills, description, and capabilities on the local interface", () => {
    const remote: RemoteAgent = {
      localHandle: "bobs-rust",
      remoteEndpoint: "https://bob.example.com:9900",
      remoteTenant: "rust-expert",
      certFingerprint: "sha256:aaaa",
    };

    const card = buildRichRemoteAgentCard({
      remote,
      localUrl: "http://localhost:9901",
      remoteCard: mockRemoteCard,
    });

    // Name and URL use the local handle
    expect(card.name).toBe("bobs-rust");
    expect(card.url).toBe("http://localhost:9901/bobs-rust");

    // Description, skills, and capabilities come from the remote card
    expect(card.description).toBe(mockRemoteCard.description);
    expect(card.skills).toEqual(mockRemoteCard.skills);
    expect(card.defaultInputModes).toEqual(mockRemoteCard.defaultInputModes);
    expect(card.defaultOutputModes).toEqual(mockRemoteCard.defaultOutputModes);
    expect(card.capabilities.stateTransitionHistory).toBe(true);

    // Local interface has no security (localhost)
    expect(card.securitySchemes).toEqual({});
    expect(card.securityRequirements).toEqual([]);
  });

  it("falls back to placeholder when remoteCard is null", () => {
    const remote: RemoteAgent = {
      localHandle: "unknown-peer",
      remoteEndpoint: "https://unknown.example.com:9900",
      remoteTenant: "some-agent",
      certFingerprint: "sha256:cccc",
    };

    const card = buildRichRemoteAgentCard({
      remote,
      localUrl: "http://localhost:9901",
      remoteCard: null,
    });

    expect(card.name).toBe("unknown-peer");
    expect(card.description).toContain("Remote agent");
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0].id).toBe("chat");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd claw-connect && pnpm test -- test/agent-card-rich.test.ts`
Expected: FAIL — `fetchRemoteAgentCard` and `buildRichRemoteAgentCard` do not exist.

- [ ] **Step 3: Write the implementation**

Add to `claw-connect/src/agent-card.ts`:

```typescript
/**
 * Fetch a remote agent's Agent Card from its well-known URL.
 * Returns null if the fetch fails or the response is not valid JSON.
 */
export async function fetchRemoteAgentCard(
  url: string,
): Promise<AgentCard | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return null;

    const data = await response.json();

    // Basic validation: must have name and url at minimum
    if (!data.name || !data.url) return null;

    return data as AgentCard;
  } catch {
    return null;
  }
}

interface BuildRichRemoteOpts {
  remote: RemoteAgent;
  localUrl: string;
  remoteCard: AgentCard | null;
}

/**
 * Build an Agent Card for a remote agent on the local interface,
 * using the remote agent's actual Agent Card for rich metadata.
 * Falls back to a placeholder if the remote card is unavailable.
 */
export function buildRichRemoteAgentCard(opts: BuildRichRemoteOpts): AgentCard {
  const { remote, localUrl, remoteCard } = opts;

  if (!remoteCard) {
    // Fallback to placeholder (same as the original buildRemoteAgentCard)
    return buildRemoteAgentCard({
      remote,
      localUrl,
      description: `Remote agent: ${remote.localHandle}`,
    });
  }

  return {
    name: remote.localHandle,
    description: remoteCard.description,
    url: `${localUrl}/${remote.localHandle}`,
    version: remoteCard.version,
    skills: remoteCard.skills,
    defaultInputModes: remoteCard.defaultInputModes,
    defaultOutputModes: remoteCard.defaultOutputModes,
    capabilities: remoteCard.capabilities,
    // No security on local interface — localhost doesn't need mTLS
    securitySchemes: {},
    securityRequirements: [],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd claw-connect && pnpm test -- test/agent-card-rich.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Integrate rich cards into server.ts**

In the `createLocalApp` function in `server.ts`, update the remote Agent Card route to use `buildRichRemoteAgentCard` and `fetchRemoteAgentCard`. Replace the existing remote card branch:

```typescript
    if (remote) {
      // Try to fetch the remote agent's actual Agent Card for rich metadata
      const agentCardUrl = `${remote.remoteEndpoint}/${remote.remoteTenant}/.well-known/agent-card.json`;
      const remoteCard = await fetchRemoteAgentCard(agentCardUrl);

      const card = buildRichRemoteAgentCard({
        remote,
        localUrl: `http://127.0.0.1:${config.server.localPort}`,
        remoteCard,
      });
      res.json(card);
      return;
    }
```

Note: The handler must become `async` if it isn't already.

Also update the root Agent Card listing to use rich descriptions when available. In the `/.well-known/agent-card.json` handler, replace the remote agent description logic:

```typescript
        description:
          config.agents[name]?.description ??
          `Remote agent: ${name}`,
```

- [ ] **Step 6: Run full test suite**

Run: `cd claw-connect && pnpm test`
Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add claw-connect/src/agent-card.ts claw-connect/src/server.ts claw-connect/test/agent-card-rich.test.ts
git commit -m "feat(claw-connect): rich Agent Card synthesis from remote agent metadata"
```

---

### Task 4: CLI `status` Command

**Files:**
- Modify: `claw-connect/bin/cli.ts`
- Create: `claw-connect/test/cli-status.test.ts`

The `status` command shows server info, registered agents, friend count, and rate limit status. It reads from config files (no running server required).

- [ ] **Step 1: Write the failing test**

Create `claw-connect/test/cli-status.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildStatusOutput } from "../src/status.js";
import type { ServerConfig, FriendsConfig } from "../src/types.js";

const serverConfig: ServerConfig = {
  server: {
    port: 9900,
    host: "0.0.0.0",
    localPort: 9901,
    rateLimit: "100/hour",
    streamTimeoutSeconds: 300,
  },
  agents: {
    "rust-expert": {
      localEndpoint: "http://localhost:18800",
      rateLimit: "50/hour",
      description: "Expert in Rust and systems programming",
    },
    "code-reviewer": {
      localEndpoint: "http://localhost:18801",
      rateLimit: "30/hour",
      description: "Code review and best practices",
    },
  },
  connectionRequests: { mode: "auto" },
  discovery: { providers: ["static", "mdns"], cacheTtlSeconds: 300 },
};

const friendsConfig: FriendsConfig = {
  friends: {
    "alice-agent": {
      fingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    "carols-ml": {
      fingerprint: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      agents: ["rust-expert"],
    },
    "daves-bot": {
      fingerprint: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    },
  },
};

describe("buildStatusOutput", () => {
  it("includes server configuration", () => {
    const output = buildStatusOutput(serverConfig, friendsConfig);

    expect(output).toContain("Public: https://0.0.0.0:9900");
    expect(output).toContain("Local: http://127.0.0.1:9901");
    expect(output).toContain("100/hour");
    expect(output).toContain("300s");
  });

  it("lists registered agents with their rate limits", () => {
    const output = buildStatusOutput(serverConfig, friendsConfig);

    expect(output).toContain("rust-expert");
    expect(output).toContain("50/hour");
    expect(output).toContain("http://localhost:18800");
    expect(output).toContain("code-reviewer");
    expect(output).toContain("30/hour");
  });

  it("shows friend count", () => {
    const output = buildStatusOutput(serverConfig, friendsConfig);

    expect(output).toContain("3 friends");
  });

  it("shows connection request mode", () => {
    const output = buildStatusOutput(serverConfig, friendsConfig);

    expect(output).toContain("auto");
  });

  it("shows discovery providers", () => {
    const output = buildStatusOutput(serverConfig, friendsConfig);

    expect(output).toContain("static");
    expect(output).toContain("mdns");
  });

  it("handles zero agents and zero friends", () => {
    const emptyConfig: ServerConfig = {
      server: {
        port: 9900,
        host: "0.0.0.0",
        localPort: 9901,
        rateLimit: "100/hour",
        streamTimeoutSeconds: 300,
      },
      agents: {},
      connectionRequests: { mode: "deny" },
      discovery: { providers: ["static"], cacheTtlSeconds: 300 },
    };
    const emptyFriends: FriendsConfig = { friends: {} };

    const output = buildStatusOutput(emptyConfig, emptyFriends);

    expect(output).toContain("No agents registered");
    expect(output).toContain("0 friends");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd claw-connect && pnpm test -- test/cli-status.test.ts`
Expected: FAIL — `Cannot find module '../src/status.js'`

- [ ] **Step 3: Write the implementation**

Create `claw-connect/src/status.ts`:

```typescript
import type { ServerConfig, FriendsConfig } from "./types.js";

/**
 * Build a human-readable status dashboard string.
 */
export function buildStatusOutput(
  config: ServerConfig,
  friends: FriendsConfig,
): string {
  const lines: string[] = [];

  lines.push("Claw Connect Status");
  lines.push("=".repeat(40));

  // Server info
  lines.push("");
  lines.push("Server");
  lines.push(`  Public: https://${config.server.host}:${config.server.port}`);
  lines.push(`  Local: http://127.0.0.1:${config.server.localPort}`);
  lines.push(`  Rate limit: ${config.server.rateLimit}`);
  lines.push(`  Stream timeout: ${config.server.streamTimeoutSeconds}s`);
  lines.push(`  Connection requests: ${config.connectionRequests.mode}`);
  lines.push(`  Discovery: ${config.discovery.providers.join(", ")}`);

  // Agents
  lines.push("");
  const agentNames = Object.keys(config.agents);
  if (agentNames.length === 0) {
    lines.push("No agents registered");
  } else {
    lines.push(`Agents (${agentNames.length})`);
    for (const [name, agent] of Object.entries(config.agents)) {
      lines.push(`  ${name}`);
      lines.push(`    Endpoint: ${agent.localEndpoint}`);
      lines.push(`    Rate limit: ${agent.rateLimit}`);
      lines.push(`    Description: ${agent.description}`);
    }
  }

  // Friends
  lines.push("");
  const friendCount = Object.keys(friends.friends).length;
  lines.push(`${friendCount} friends`);

  if (friendCount > 0) {
    for (const [handle, entry] of Object.entries(friends.friends)) {
      const scope = entry.agents
        ? ` (scoped: ${entry.agents.join(", ")})`
        : " (all agents)";
      lines.push(`  ${handle}${scope}`);
    }
  }

  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd claw-connect && pnpm test -- test/cli-status.test.ts`
Expected: 6 tests PASS.

- [ ] **Step 5: Wire into CLI**

In `claw-connect/bin/cli.ts`, add the import:

```typescript
import { buildStatusOutput } from "../src/status.js";
```

Add the `status` command after the existing `agents` command:

```typescript
program
  .command("status")
  .description("Show server status, registered agents, friend count")
  .option("--dir <path>", "Config directory", DEFAULT_CONFIG_DIR)
  .action((opts) => {
    const configDir = opts.dir;
    const serverTomlPath = path.join(configDir, "server.toml");

    if (!fs.existsSync(serverTomlPath)) {
      console.error("Not initialized. Run 'claw-connect init' first.");
      process.exit(1);
    }

    const serverConfig = loadServerConfig(serverTomlPath);
    const friendsConfig = loadFriendsConfig(
      path.join(configDir, "friends.toml"),
    );

    console.log(buildStatusOutput(serverConfig, friendsConfig));
  });
```

Add the `loadServerConfig` and `loadFriendsConfig` imports if not already present:

```typescript
import { loadServerConfig, loadFriendsConfig } from "../src/config.js";
```

- [ ] **Step 6: Test CLI manually**

Run:
```bash
cd claw-connect
npx tsx bin/cli.ts init --dir /tmp/cc-status-test
npx tsx bin/cli.ts register --name test-agent --description "Test agent" --endpoint http://localhost:18800 --dir /tmp/cc-status-test
npx tsx bin/cli.ts status --dir /tmp/cc-status-test
```

Expected:
```
Claw Connect Status
========================================

Server
  Public: https://0.0.0.0:9900
  Local: http://127.0.0.1:9901
  Rate limit: 100/hour
  Stream timeout: 300s
  Connection requests: deny
  Discovery: static

Agents (1)
  test-agent
    Endpoint: http://localhost:18800
    Rate limit: 50/hour
    Description: Test agent

0 friends
```

- [ ] **Step 7: Cleanup and commit**

```bash
rm -rf /tmp/cc-status-test
git add claw-connect/src/status.ts claw-connect/test/cli-status.test.ts claw-connect/bin/cli.ts
git commit -m "feat(claw-connect): claw-connect status dashboard command"
```

---

### Task 5: CLI `ping` Command

**Files:**
- Modify: `claw-connect/bin/cli.ts`
- Create: `claw-connect/src/ping.ts`
- Create: `claw-connect/test/cli-ping.test.ts`

The `ping` command fetches a remote agent's Agent Card to check if they're reachable. It can take a handle (looked up from config) or a direct Agent Card URL.

- [ ] **Step 1: Write the failing test**

Create `claw-connect/test/cli-ping.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import express from "express";
import { pingAgent } from "../src/ping.js";

let mockServer: http.Server;
const mockPort = 48910;

beforeAll(() => {
  const app = express();

  app.get("/reachable-agent/.well-known/agent-card.json", (_req, res) => {
    res.json({
      name: "reachable-agent",
      description: "I am reachable",
      url: `http://127.0.0.1:${mockPort}/reachable-agent`,
      version: "1.0.0",
      skills: [
        {
          id: "chat",
          name: "chat",
          description: "General chat",
          tags: [],
        },
      ],
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      capabilities: {
        streaming: true,
        pushNotifications: false,
        stateTransitionHistory: false,
      },
      securitySchemes: {},
      securityRequirements: [],
    });
  });

  mockServer = app.listen(mockPort, "127.0.0.1");
});

afterAll(() => {
  mockServer?.close();
});

describe("pingAgent", () => {
  it("returns success with agent info when reachable", async () => {
    const result = await pingAgent(
      `http://127.0.0.1:${mockPort}/reachable-agent/.well-known/agent-card.json`,
    );

    expect(result.reachable).toBe(true);
    expect(result.name).toBe("reachable-agent");
    expect(result.description).toBe("I am reachable");
    expect(result.skills).toHaveLength(1);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.latencyMs).toBeLessThan(5000);
  });

  it("returns unreachable for bad URLs", async () => {
    const result = await pingAgent(
      "http://127.0.0.1:59999/ghost/.well-known/agent-card.json",
    );

    expect(result.reachable).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("returns unreachable for non-JSON responses", async () => {
    const result = await pingAgent(
      `http://127.0.0.1:${mockPort}/bad-path`,
    );

    expect(result.reachable).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd claw-connect && pnpm test -- test/cli-ping.test.ts`
Expected: FAIL — `Cannot find module '../src/ping.js'`

- [ ] **Step 3: Write the implementation**

Create `claw-connect/src/ping.ts`:

```typescript
export interface PingResult {
  reachable: boolean;
  name?: string;
  description?: string;
  skills?: { id: string; name: string; description: string }[];
  latencyMs?: number;
  error?: string;
}

/**
 * Ping a remote agent by fetching their Agent Card.
 * Returns reachability status and agent metadata.
 */
export async function pingAgent(agentCardUrl: string): Promise<PingResult> {
  const start = Date.now();

  try {
    const response = await fetch(agentCardUrl, {
      signal: AbortSignal.timeout(10000),
    });

    const latencyMs = Date.now() - start;

    if (!response.ok) {
      return {
        reachable: false,
        latencyMs,
        error: `HTTP ${response.status} ${response.statusText}`,
      };
    }

    const data = await response.json();

    if (!data.name) {
      return {
        reachable: false,
        latencyMs,
        error: "Response is not a valid Agent Card (missing name)",
      };
    }

    return {
      reachable: true,
      name: data.name,
      description: data.description,
      skills: data.skills,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    return {
      reachable: false,
      latencyMs,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * Format a ping result as a human-readable string.
 */
export function formatPingResult(
  url: string,
  result: PingResult,
): string {
  const lines: string[] = [];

  if (result.reachable) {
    lines.push(`REACHABLE  ${result.name} (${result.latencyMs}ms)`);
    lines.push(`  URL: ${url}`);
    if (result.description) {
      lines.push(`  Description: ${result.description}`);
    }
    if (result.skills && result.skills.length > 0) {
      lines.push(`  Skills:`);
      for (const skill of result.skills) {
        lines.push(`    - ${skill.name}: ${skill.description}`);
      }
    }
  } else {
    lines.push(`UNREACHABLE  ${url}`);
    if (result.error) {
      lines.push(`  Error: ${result.error}`);
    }
    if (result.latencyMs !== undefined) {
      lines.push(`  Latency: ${result.latencyMs}ms`);
    }
  }

  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd claw-connect && pnpm test -- test/cli-ping.test.ts`
Expected: 3 tests PASS.

- [ ] **Step 5: Wire into CLI**

In `claw-connect/bin/cli.ts`, add the imports:

```typescript
import { pingAgent, formatPingResult } from "../src/ping.js";
```

Add the `ping` command:

```typescript
program
  .command("ping <target>")
  .description(
    "Check if a remote agent is reachable (by handle or Agent Card URL)",
  )
  .option("--dir <path>", "Config directory", DEFAULT_CONFIG_DIR)
  .action(async (target, opts) => {
    let agentCardUrl: string;

    // If target looks like a URL, use it directly
    if (target.startsWith("http://") || target.startsWith("https://")) {
      agentCardUrl = target;
    } else {
      // Look up handle from friends.toml or static discovery config
      // For now, assume the target is a handle and construct the URL
      // from the discovery/static config in server.toml
      const configDir = opts.dir;
      const serverTomlPath = path.join(configDir, "server.toml");

      if (!fs.existsSync(serverTomlPath)) {
        console.error("Not initialized. Run 'claw-connect init' first.");
        process.exit(1);
      }

      const serverConfig = loadServerConfig(serverTomlPath);

      // Check static discovery peers
      const staticPeers = (serverConfig as any).discovery?.static?.peers ?? {};
      const peer = staticPeers[target];

      if (peer?.agent_card_url) {
        agentCardUrl = peer.agent_card_url;
      } else {
        console.error(
          `Unknown handle "${target}". Use a full Agent Card URL or add the peer to static discovery config.`,
        );
        process.exit(1);
      }
    }

    console.log(`Pinging ${agentCardUrl} ...`);
    const result = await pingAgent(agentCardUrl);
    console.log(formatPingResult(agentCardUrl, result));

    if (!result.reachable) {
      process.exit(1);
    }
  });
```

- [ ] **Step 6: Test CLI manually**

Run:
```bash
cd claw-connect
# Ping a nonexistent agent (should show UNREACHABLE)
npx tsx bin/cli.ts ping http://127.0.0.1:59999/ghost/.well-known/agent-card.json
echo "Exit code: $?"
```

Expected:
```
Pinging http://127.0.0.1:59999/ghost/.well-known/agent-card.json ...
UNREACHABLE  http://127.0.0.1:59999/ghost/.well-known/agent-card.json
  Error: fetch failed
Exit code: 1
```

- [ ] **Step 7: Commit**

```bash
git add claw-connect/src/ping.ts claw-connect/test/cli-ping.test.ts claw-connect/bin/cli.ts
git commit -m "feat(claw-connect): claw-connect ping command for remote agent reachability"
```

---

### Task 6: Broken Connection Cleanup

**Files:**
- Modify: `claw-connect/src/streaming.ts`
- Modify: `claw-connect/test/streaming.test.ts`

This task ensures that when either end of an SSE stream disconnects, the other side is cleaned up properly. The `proxySSEStream` function already handles downstream close via `res.on("close")`. This task adds explicit upstream abort handling and tests for both directions.

- [ ] **Step 1: Write additional tests for broken connection handling**

Add to `claw-connect/test/streaming.test.ts`:

```typescript
import http from "http";
import express from "express";
import { proxySSEStream, initSSEResponse, formatSSEEvent } from "../src/streaming.js";
import type { Response as ExpressResponse } from "express";

describe("proxySSEStream broken connections", () => {
  it("cleans up when upstream closes unexpectedly", async () => {
    // Create a mock upstream that sends one event then closes
    const mockUpstreamPort = 48950;
    const upstreamApp = express();

    upstreamApp.post("/stream", (_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      res.write(
        formatSSEEvent({
          kind: "status-update",
          taskId: "t1",
          contextId: "c1",
          status: { state: "TASK_STATE_WORKING" },
          final: false,
        }),
      );

      // Close abruptly after 50ms
      setTimeout(() => {
        res.destroy();
      }, 50);
    });

    const upstreamServer = upstreamApp.listen(mockUpstreamPort, "127.0.0.1");

    try {
      const response = await fetch(
        `http://127.0.0.1:${mockUpstreamPort}/stream`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      );

      // Create a mock downstream Express response
      const downstreamPort = 48951;
      const downstreamApp = express();
      let collectedData = "";

      const result = await new Promise<string>((resolve) => {
        downstreamApp.post("/test", async (req, downstreamRes) => {
          // Collect what gets written to downstream
          const originalWrite = downstreamRes.write.bind(downstreamRes);
          downstreamRes.write = ((chunk: any) => {
            collectedData += chunk.toString();
            return originalWrite(chunk);
          }) as any;

          await proxySSEStream({
            upstreamResponse: response,
            downstream: downstreamRes,
            timeoutMs: 10000,
            taskId: "t1",
            contextId: "c1",
          });

          resolve(collectedData);
        });

        const downstreamServer = downstreamApp.listen(
          downstreamPort,
          "127.0.0.1",
          async () => {
            await fetch(`http://127.0.0.1:${downstreamPort}/test`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}",
            }).catch(() => {});

            downstreamServer.close();
          },
        );
      });

      // Should have received the first event and a failure event
      expect(result).toContain("TASK_STATE_WORKING");
    } finally {
      upstreamServer.close();
    }
  });

  it("cleans up when upstream returns no body", async () => {
    // Create a mock response with no body
    const mockResponse = new Response(null, { status: 200 });

    const downstreamPort = 48952;
    const downstreamApp = express();
    let collectedData = "";

    await new Promise<void>((resolve) => {
      downstreamApp.post("/test", async (_req, downstreamRes) => {
        const originalWrite = downstreamRes.write.bind(downstreamRes);
        downstreamRes.write = ((chunk: any) => {
          collectedData += chunk.toString();
          return originalWrite(chunk);
        }) as any;

        await proxySSEStream({
          upstreamResponse: mockResponse,
          downstream: downstreamRes,
          timeoutMs: 10000,
          taskId: "t1",
          contextId: "c1",
        });

        resolve();
      });

      const server = downstreamApp.listen(downstreamPort, "127.0.0.1", async () => {
        await fetch(`http://127.0.0.1:${downstreamPort}/test`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }).catch(() => {});
        server.close();
      });
    });

    expect(collectedData).toContain("TASK_STATE_FAILED");
    expect(collectedData).toContain("no stream body");
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd claw-connect && pnpm test -- test/streaming.test.ts`
Expected: All tests PASS including the new broken connection tests.

- [ ] **Step 3: Commit**

```bash
git add claw-connect/src/streaming.ts claw-connect/test/streaming.test.ts
git commit -m "test(claw-connect): broken connection cleanup tests for SSE proxy"
```

---

### Task 7: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `cd claw-connect && pnpm test`
Expected: All tests PASS across all files:
- `streaming.test.ts` — SSE utilities + broken connection cleanup
- `streaming-e2e.test.ts` — full streaming through two servers + timeout
- `agent-card-rich.test.ts` — rich Agent Card synthesis
- `cli-status.test.ts` — status dashboard
- `cli-ping.test.ts` — ping reachability
- All existing Phase 1-4 tests unchanged

- [ ] **Step 2: Run typecheck**

Run: `cd claw-connect && pnpm typecheck`
Expected: No errors.

- [ ] **Step 3: Manual smoke test — streaming**

```bash
cd claw-connect

# Set up two servers
npx tsx bin/cli.ts init --dir /tmp/cc-stream-a
npx tsx bin/cli.ts init --dir /tmp/cc-stream-b
npx tsx bin/cli.ts register --name agent-a --description "Agent A" --endpoint http://localhost:28850 --dir /tmp/cc-stream-a
npx tsx bin/cli.ts register --name agent-b --description "Agent B" --endpoint http://localhost:38850 --dir /tmp/cc-stream-b

# Check status
npx tsx bin/cli.ts status --dir /tmp/cc-stream-a
npx tsx bin/cli.ts status --dir /tmp/cc-stream-b

# Ping (will fail since no server is running — that's expected)
npx tsx bin/cli.ts ping http://127.0.0.1:59999/ghost/.well-known/agent-card.json
echo "Exit code: $? (expected 1)"
```

Expected: `status` shows server config, agents, and 0 friends. `ping` shows UNREACHABLE with exit code 1.

- [ ] **Step 4: Cleanup**

```bash
rm -rf /tmp/cc-stream-a /tmp/cc-stream-b
```

- [ ] **Step 5: Final commit with any fixes**

```bash
git add -A claw-connect/
git commit -m "feat(claw-connect): Phase 5 complete — SSE streaming, status dashboard, ping, rich Agent Cards"
```
