import { describe, it, expect } from "vitest";
import {
  rateLimitResponse,
  notFriendResponse,
  agentNotFoundResponse,
  agentScopeDeniedResponse,
  agentTimeoutResponse,
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
