// packages/tidepool/test/cli/serve-daemon.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { runInit } from "../../src/cli/init.js";
import {
  isServeRunning,
  spawnServeDaemon,
  LOGS_DIRNAME,
} from "../../src/cli/serve-daemon.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-daemon-"));
}

async function startStubServer(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((_req, res) => {
    res.statusCode = 200;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  return { server, port };
}

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers) s.close();
  servers.length = 0;
});

describe("isServeRunning", () => {
  it("returns not-running when no config present", async () => {
    const dir = tmp();
    const result = await isServeRunning({ configDir: dir });
    expect(result.running).toBe(false);
  });

  it("returns not-running when port does not respond", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    const result = await isServeRunning({
      configDir: dir,
      localPortOverride: 1, // reserved, won't answer
    });
    expect(result.running).toBe(false);
  });

  it("returns running when the port answers", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });

    const { server: stub, port: localPort } = await startStubServer();
    servers.push(stub);

    const result = await isServeRunning({
      configDir: dir,
      localPortOverride: localPort,
    });
    expect(result.running).toBe(true);
  });
});

describe("spawnServeDaemon", () => {
  it("invokes the injected spawner with detached + stdio and writes logs dir", async () => {
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

    const { server: stub, port } = await startStubServer();
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

    expect(capturedArgs).toEqual(["start"]);
    expect(capturedOptions?.detached).toBe(true);
    expect(fs.existsSync(path.join(dir, LOGS_DIRNAME))).toBe(true);
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
  });
});
