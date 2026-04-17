import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveAgentName } from "../../src/cli/name-resolver.js";
import type { ServerConfig } from "../../src/types.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-name-"));
}

function makeServerConfig(agentNames: string[] = []): ServerConfig {
  const agents: ServerConfig["agents"] = {};
  for (const n of agentNames) {
    agents[n] = { rateLimit: "50/hour", description: "", timeoutSeconds: 30 };
  }
  return {
    server: { port: 9900, host: "0.0.0.0", localPort: 9901, rateLimit: "100/hour", streamTimeoutSeconds: 30 },
    agents,
    connectionRequests: { mode: "deny" },
    discovery: { providers: ["static"], cacheTtlSeconds: 300 },
    validation: { mode: "warn" },
  };
}

describe("resolveAgentName", () => {
  it("uses explicit arg when provided", async () => {
    const cwd = tmp();
    const result = await resolveAgentName({
      cwd,
      serverConfig: makeServerConfig(),
      explicit: "alice-dev",
    });
    expect(result).toBe("alice-dev");
  });

  it("rejects invalid explicit name", async () => {
    const cwd = tmp();
    await expect(
      resolveAgentName({ cwd, serverConfig: makeServerConfig(), explicit: "Alice!" }),
    ).rejects.toThrow(/lowercase/i);
  });

  it("reuses name from existing .mcp.json's a2a entry", async () => {
    const cwd = tmp();
    fs.writeFileSync(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          a2a: { command: "a2a-claude-code-adapter", args: ["--agent", "donkey"] },
          other: { command: "foo", args: [] },
        },
      }),
    );
    const result = await resolveAgentName({ cwd, serverConfig: makeServerConfig() });
    expect(result).toBe("donkey");
  });

  it("generates a name when no arg and no .mcp.json", async () => {
    const cwd = tmp();
    const result = await resolveAgentName({
      cwd,
      serverConfig: makeServerConfig(),
      rng: () => "zebra",
    });
    expect(result).toBe("zebra");
  });

  it("re-rolls on collision with existing agent", async () => {
    const cwd = tmp();
    const names = ["donkey", "donkey", "zebra"];
    let i = 0;
    const result = await resolveAgentName({
      cwd,
      serverConfig: makeServerConfig(["donkey"]),
      rng: () => names[i++]!,
    });
    expect(result).toBe("zebra");
  });

  it("falls back to <name>-<hex6> after 5 collisions", async () => {
    const cwd = tmp();
    const result = await resolveAgentName({
      cwd,
      serverConfig: makeServerConfig(["donkey"]),
      rng: () => "donkey",
    });
    expect(result).toMatch(/^donkey-[0-9a-f]{6}$/);
  });
});
