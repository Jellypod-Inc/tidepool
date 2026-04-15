// packages/claw-connect/test/cli/serve-daemon.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { runInit } from "../../src/cli/init.js";
import {
  isServeRunning,
  spawnServeDaemon,
  PID_FILENAME,
} from "../../src/cli/serve-daemon.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-daemon-"));
}

async function startStubServer(port: number): Promise<http.Server> {
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

describe("isServeRunning", () => {
  it("returns false when PID file is absent", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    const result = await isServeRunning({ configDir: dir });
    expect(result.running).toBe(false);
    expect(result.reason).toBe("no-pid-file");
  });

  it("cleans up stale PID file and returns false", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    fs.writeFileSync(path.join(dir, PID_FILENAME), "999999");
    const result = await isServeRunning({ configDir: dir });
    expect(result.running).toBe(false);
    expect(result.reason).toBe("stale-pid-file");
    expect(fs.existsSync(path.join(dir, PID_FILENAME))).toBe(false);
  });

  it("returns true when PID alive and port responds", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    fs.writeFileSync(path.join(dir, PID_FILENAME), String(process.pid));

    const localPort = 51234;
    const stub = await startStubServer(localPort);
    servers.push(stub);

    const result = await isServeRunning({
      configDir: dir,
      localPortOverride: localPort,
    });
    expect(result.running).toBe(true);
    expect(result.pid).toBe(process.pid);
  });
});

describe("spawnServeDaemon", () => {
  it("invokes the injected spawner with detached + stdio", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });

    let capturedArgs: string[] | null = null;
    let capturedOptions: Record<string, unknown> | null = null;

    const fakeProcess = {
      pid: 424242,
      unref: () => {},
      once: () => fakeProcess,
      kill: () => true,
    };

    const port = 51235;
    const stub = await startStubServer(port);
    servers.push(stub);

    await spawnServeDaemon({
      configDir: dir,
      localPortOverride: port,
      readinessTimeoutMs: 500,
      spawner: (_cmd, args, options) => {
        capturedArgs = args as string[];
        capturedOptions = options as Record<string, unknown>;
        return fakeProcess as never;
      },
    });

    expect(capturedArgs).toEqual(["serve"]);
    expect(capturedOptions?.detached).toBe(true);
    const pidContent = fs.readFileSync(path.join(dir, PID_FILENAME), "utf-8");
    expect(pidContent.trim()).toBe("424242");
    expect(fs.existsSync(path.join(dir, "logs"))).toBe(true);
  });

  it("errors out if port never becomes ready", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });

    let killed = false;
    const fakeProcess = {
      pid: 424243,
      unref: () => {},
      once: () => fakeProcess,
      kill: () => {
        killed = true;
        return true;
      },
    };

    await expect(
      spawnServeDaemon({
        configDir: dir,
        localPortOverride: 1,
        readinessTimeoutMs: 150,
        spawner: () => fakeProcess as never,
      }),
    ).rejects.toThrow(/not become ready/i);

    expect(killed).toBe(true);
    expect(fs.existsSync(path.join(dir, PID_FILENAME))).toBe(false);
  });
});
