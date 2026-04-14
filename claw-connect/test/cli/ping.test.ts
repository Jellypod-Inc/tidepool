import { describe, it, expect, afterAll, beforeAll } from "vitest";
import express from "express";
import http from "http";
import { runPing } from "../../src/cli/ping.js";

describe("runPing", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    const app = express();
    app.get("/card", (_req, res) => {
      res.json({
        name: "test-agent",
        description: "hello",
        url: "http://localhost",
        version: "1.0.0",
        skills: [{ id: "s1", name: "s1", description: "" }],
        defaultInputModes: [],
        defaultOutputModes: [],
        capabilities: {},
        securitySchemes: {},
        securityRequirements: [],
      });
    });
    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => server.close());

  it("returns a formatted line with REACHABLE for a real agent card", async () => {
    const out = await runPing({ url: `http://127.0.0.1:${port}/card` });
    expect(out).toContain("REACHABLE");
    expect(out).toContain("test-agent");
  });

  it("returns UNREACHABLE when the endpoint is closed", async () => {
    const out = await runPing({ url: `http://127.0.0.1:1/nope` });
    expect(out).toContain("UNREACHABLE");
  });
});
