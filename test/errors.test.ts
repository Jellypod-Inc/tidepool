import { describe, it, expect } from "vitest";
import {
  rateLimitResponse,
  notFriendResponse,
  agentNotFoundResponse,
  agentScopeDeniedResponse,
  agentTimeoutResponse,
  malformedRequestResponse,
} from "../src/errors.js";

describe("rateLimitResponse", () => {
  it("returns a 429-shaped A2A error with retryAfterSeconds", () => {
    const resp = rateLimitResponse(360);

    expect(resp.statusCode).toBe(429);
    expect(resp.headers["Retry-After"]).toBe("360");
    expect(resp.body.status.state).toBe("failed");
    expect(resp.body.artifacts[0].parts[0].text).toContain("Rate limit");
  });
});

describe("notFriendResponse", () => {
  it("returns TASK_STATE_REJECTED for non-friends", () => {
    const resp = notFriendResponse();

    expect(resp.statusCode).toBe(403);
    expect(resp.body.status.state).toBe("rejected");
    expect(resp.body.artifacts[0].parts[0].text).toContain("not authorized");
  });
});

describe("agentNotFoundResponse", () => {
  it("returns 404 with TASK_STATE_FAILED", () => {
    const resp = agentNotFoundResponse("unknown-agent");

    expect(resp.statusCode).toBe(404);
    expect(resp.body.status.state).toBe("failed");
    expect(resp.body.artifacts[0].parts[0].text).toContain("unknown-agent");
  });
});

describe("agentScopeDeniedResponse", () => {
  it("returns 403 with TASK_STATE_REJECTED", () => {
    const resp = agentScopeDeniedResponse("rust-expert");

    expect(resp.statusCode).toBe(403);
    expect(resp.body.status.state).toBe("rejected");
    expect(resp.body.artifacts[0].parts[0].text).toContain("rust-expert");
  });
});

describe("agentTimeoutResponse", () => {
  it("returns TASK_STATE_FAILED with timeout message", () => {
    const resp = agentTimeoutResponse("rust-expert", 30);

    expect(resp.statusCode).toBe(504);
    expect(resp.body.status.state).toBe("failed");
    expect(resp.body.artifacts[0].parts[0].text).toContain("rust-expert");
    expect(resp.body.artifacts[0].parts[0].text).toContain("30");
  });
});

describe("error response id correlation", () => {
  it("echoes taskId into body.id when provided", () => {
    const taskId = "client-msg-abc-123";

    expect(rateLimitResponse(10, taskId).body.id).toBe(taskId);
    expect(notFriendResponse(taskId).body.id).toBe(taskId);
    expect(agentNotFoundResponse("x", taskId).body.id).toBe(taskId);
    expect(agentScopeDeniedResponse("x", taskId).body.id).toBe(taskId);
    expect(agentTimeoutResponse("x", 5, taskId).body.id).toBe(taskId);
  });

  it("falls back to a fresh uuid when taskId is absent", () => {
    // Backwards compatible: old callers keep working.
    const id = rateLimitResponse(10).body.id;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe("malformedRequestResponse", () => {
  it("returns 400 with state=failed and the supplied detail", () => {
    const resp = malformedRequestResponse("messageId: invalid enum value", "m-1");
    expect(resp.statusCode).toBe(400);
    expect(resp.body.status.state).toBe("failed");
    expect(resp.body.id).toBe("m-1");
    expect(resp.body.artifacts[0].parts[0].text).toContain(
      "messageId: invalid enum value",
    );
  });

  it("generates a uuid when no taskId is provided", () => {
    const resp = malformedRequestResponse("bad role");
    expect(resp.body.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

// ===== Structured error response tests (new taxonomy) =====

import {
  structuredError,
  originDeniedResponse,
  peerNotFoundResponse,
  sessionConflictResponse,
  peerUnreachableResponse,
  agentOfflineResponse,
  peerTimeoutResponse,
  unsupportedOperationResponse,
} from "../src/errors.js";

describe("structuredError", () => {
  it("builds a { error: { code, message, hint } } body", () => {
    const resp = structuredError(400, "invalid_request", "bad body", "check JSON syntax");
    expect(resp.statusCode).toBe(400);
    expect(resp.body).toEqual({
      error: { code: "invalid_request", message: "bad body", hint: "check JSON syntax" },
    });
  });
});

describe("originDeniedResponse", () => {
  it("returns 403 origin_denied", () => {
    const resp = originDeniedResponse("http://evil.example");
    expect(resp.statusCode).toBe(403);
    expect(resp.body.error.code).toBe("origin_denied");
    expect(resp.body.error.message).toContain("http://evil.example");
  });
});

describe("peerNotFoundResponse (structured)", () => {
  it("returns 404 peer_not_found", () => {
    const resp = peerNotFoundResponse("charlie");
    expect(resp.statusCode).toBe(404);
    expect(resp.body.error.code).toBe("peer_not_found");
    expect(resp.body.error.message).toContain("charlie");
    expect(resp.body.error.hint).toBeTruthy();
  });
});

describe("sessionConflictResponse", () => {
  it("returns 409 session_conflict with handle in message", () => {
    const resp = sessionConflictResponse("alice");
    expect(resp.statusCode).toBe(409);
    expect(resp.body.error.code).toBe("session_conflict");
    expect(resp.body.error.message).toContain("alice");
    expect(resp.body.error.hint).toBeTruthy();
  });
});

describe("peerUnreachableResponse", () => {
  it("returns 502 peer_unreachable with handle in message", () => {
    const resp = peerUnreachableResponse("bob");
    expect(resp.statusCode).toBe(502);
    expect(resp.body.error.code).toBe("peer_unreachable");
    expect(resp.body.error.message).toContain("bob");
    expect(resp.body.error.hint).toBeTruthy();
  });
});

describe("agentOfflineResponse", () => {
  it("returns 503 agent_offline with handle in message", () => {
    const resp = agentOfflineResponse("alice");
    expect(resp.statusCode).toBe(503);
    expect(resp.body.error.code).toBe("agent_offline");
    expect(resp.body.error.message).toContain("alice");
    expect(resp.body.error.hint).toBeTruthy();
  });
});

describe("peerTimeoutResponse (structured)", () => {
  it("returns 504 peer_timeout with handle and timeout in message", () => {
    const resp = peerTimeoutResponse("bob", 30);
    expect(resp.statusCode).toBe(504);
    expect(resp.body.error.code).toBe("peer_timeout");
    expect(resp.body.error.message).toContain("bob");
    expect(resp.body.error.message).toContain("30");
    expect(resp.body.error.hint).toBeTruthy();
  });
});

describe("unsupportedOperationResponse", () => {
  it("returns 405 with A2A JSON-RPC error envelope", () => {
    const resp = unsupportedOperationResponse("tasks/get", "msg-1");
    expect(resp.statusCode).toBe(405);
    expect(resp.body).toEqual({
      jsonrpc: "2.0",
      error: {
        code: -32006,
        message: expect.stringContaining("tasks/get"),
      },
      id: "msg-1",
    });
  });
});
