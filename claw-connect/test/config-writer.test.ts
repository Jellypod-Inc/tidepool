import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { writeServerConfig, readOrInitServerConfig } from "../src/config-writer.js";
import { loadServerConfig } from "../src/config.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-cfg-writer-"));
}

describe("writeServerConfig", () => {
  it("writes a TOML file that round-trips through loadServerConfig", () => {
    const dir = tmp();
    const p = path.join(dir, "server.toml");
    const cfg = {
      server: { port: 9900, host: "0.0.0.0", localPort: 9901, rateLimit: "100/hour", streamTimeoutSeconds: 300 },
      agents: {
        "alice-dev": { localEndpoint: "http://127.0.0.1:28800", rateLimit: "50/hour", description: "dev", timeoutSeconds: 30 },
      },
      connectionRequests: { mode: "deny" as const },
      discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      validation: { mode: "warn" as const },
    };
    writeServerConfig(p, cfg);
    const reloaded = loadServerConfig(p);
    expect(reloaded.server.port).toBe(9900);
    expect(reloaded.agents["alice-dev"].localEndpoint).toBe("http://127.0.0.1:28800");
    expect(reloaded.validation.mode).toBe("warn");
  });
});

describe("readOrInitServerConfig", () => {
  it("returns defaults and creates the file when absent", () => {
    const dir = tmp();
    const p = path.join(dir, "server.toml");
    const cfg = readOrInitServerConfig(p);
    expect(fs.existsSync(p)).toBe(true);
    expect(cfg.server.port).toBe(9900);
    expect(cfg.agents).toEqual({});
    expect(cfg.validation.mode).toBe("warn");
  });

  it("returns existing config when file is present", () => {
    const dir = tmp();
    const p = path.join(dir, "server.toml");
    fs.writeFileSync(
      p,
      [
        "[server]",
        "port = 7777",
        "host = \"0.0.0.0\"",
        "localPort = 7778",
        "rateLimit = \"100/hour\"",
        "streamTimeoutSeconds = 300",
        "",
        "[connectionRequests]",
        "mode = \"deny\"",
        "",
        "[discovery]",
        "providers = [\"static\"]",
        "cacheTtlSeconds = 300",
      ].join("\n"),
    );
    const cfg = readOrInitServerConfig(p);
    expect(cfg.server.port).toBe(7777);
  });
});
