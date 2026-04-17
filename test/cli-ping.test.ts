import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import express from "express";
import { pingAgent } from "../src/ping.js";

let mockServer: http.Server;
const mockPort = 48910;

beforeAll(() => {
  const app = express();

  app.get("/malformed-card/.well-known/agent-card.json", (_req, res) => {
    // 200 OK but missing required `name` — schema rejects this.
    res.json({ description: "no name here" });
  });

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

  it("returns unreachable when the response is JSON but fails schema validation", async () => {
    const result = await pingAgent(
      `http://127.0.0.1:${mockPort}/malformed-card/.well-known/agent-card.json`,
    );
    expect(result.reachable).toBe(false);
    expect(result.error).toContain("not a valid Agent Card");
  });
});
