// packages/claw-connect/test/cli/claude-code-start-e2e.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { runClaudeCodeStart } from "../../src/cli/claude-code-start.js";
import { loadServerConfig } from "../../src/config.js";

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function startStub(port: number): Promise<http.Server> {
  const server = http.createServer((_req, res) => {
    res.statusCode = 200;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return server;
}

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers) s.close();
  servers.length = 0;
});

describe("runClaudeCodeStart — fresh repo (default)", () => {
  it("initializes, registers an agent, writes .mcp.json, starts daemon, execs claude", async () => {
    const configDir = tmp("cc-start-home-");
    const cwd = tmp("cc-start-cwd-");

    const LOCAL_PORT = 52100;
    const stub = await startStub(LOCAL_PORT);
    servers.push(stub);

    const execCalls: Array<{ cmd: string; args: string[]; cwd: string }> = [];

    const fakeProcess = { pid: 99999, unref: () => {}, once: () => fakeProcess, kill: () => true };

    await runClaudeCodeStart({
      configDir,
      cwd,
      explicitAgent: "donkey",
      debug: false,
      localPortOverride: LOCAL_PORT,
      spawner: () => fakeProcess as never,
      readinessTimeoutMs: 500,
      claudeExecutor: (cmd, args, options) => {
        execCalls.push({ cmd, args, cwd: options.cwd ?? "" });
      },
      claudeOnPath: () => true,
      rng: () => "donkey",
    });

    const cfg = loadServerConfig(path.join(configDir, "server.toml"));
    expect(cfg.agents.donkey).toBeDefined();

    const mcp = JSON.parse(fs.readFileSync(path.join(cwd, ".mcp.json"), "utf-8"));
    expect(mcp.mcpServers.a2a.args).toEqual(["--agent", "donkey"]);

    expect(fs.existsSync(path.join(configDir, "serve.pid"))).toBe(true);

    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].cmd).toBe("claude");
    expect(execCalls[0].args).toEqual([
      "--dangerously-load-development-channels",
      "server:a2a",
    ]);
    expect(execCalls[0].cwd).toBe(cwd);
  });
});

describe("runClaudeCodeStart — re-entry", () => {
  it("reuses existing agent name and skips registration", async () => {
    const configDir = tmp("cc-restart-home-");
    const cwd = tmp("cc-restart-cwd-");
    const LOCAL_PORT = 52101;
    const stub = await startStub(LOCAL_PORT);
    servers.push(stub);

    const fakeProcess = { pid: 99998, unref: () => {}, once: () => fakeProcess, kill: () => true };
    const execCalls: Array<{ args: string[] }> = [];
    const run = () =>
      runClaudeCodeStart({
        configDir,
        cwd,
        debug: false,
        localPortOverride: LOCAL_PORT,
        spawner: () => fakeProcess as never,
        readinessTimeoutMs: 500,
        claudeExecutor: (_cmd, args) => {
          execCalls.push({ args });
        },
        claudeOnPath: () => true,
        rng: () => "donkey",
      });

    await run();
    const firstCfg = loadServerConfig(path.join(configDir, "server.toml"));
    const firstPort = firstCfg.agents.donkey.localEndpoint;

    await run();
    const secondCfg = loadServerConfig(path.join(configDir, "server.toml"));
    expect(Object.keys(secondCfg.agents)).toEqual(["donkey"]);
    expect(secondCfg.agents.donkey.localEndpoint).toBe(firstPort);
    expect(execCalls).toHaveLength(2);
  });
});

describe("runClaudeCodeStart — --debug", () => {
  it("does not exec claude and does not create PID file", async () => {
    const configDir = tmp("cc-debug-home-");
    const cwd = tmp("cc-debug-cwd-");

    const serveInvocations: Array<unknown> = [];

    await runClaudeCodeStart({
      configDir,
      cwd,
      explicitAgent: "zebra",
      debug: true,
      claudeExecutor: () => {
        throw new Error("claude should not be execed in --debug mode");
      },
      claudeOnPath: () => true,
      rng: () => "zebra",
      debugServeRunner: async () => {
        serveInvocations.push("ran");
        return;
      },
    });

    expect(fs.existsSync(path.join(configDir, "serve.pid"))).toBe(false);
    expect(fs.existsSync(path.join(cwd, ".mcp.json"))).toBe(true);
    expect(serveInvocations).toEqual(["ran"]);
  });
});
