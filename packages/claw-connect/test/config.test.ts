import { describe, it, expect } from "vitest";
import { loadServerConfig, loadFriendsConfig } from "../src/config.js";
import { ServerConfigSchema } from "../src/schemas.js";
import fs from "fs";
import os from "os";
import path from "path";

const fixturesDir = path.resolve(import.meta.dirname, "../fixtures");

function writeTempToml(name: string, contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-config-test-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  return file;
}

describe("loadServerConfig", () => {
  it("loads and parses server.toml", () => {
    const config = loadServerConfig(path.join(fixturesDir, "server.toml"));

    expect(config.server.port).toBe(9900);
    expect(config.server.host).toBe("0.0.0.0");
    expect(config.server.localPort).toBe(9901);
    expect(config.server.rateLimit).toBe("100/hour");
    expect(config.agents["rust-expert"].localEndpoint).toBe(
      "http://localhost:18800",
    );
    expect(config.agents["rust-expert"].rateLimit).toBe("50/hour");
    expect(config.agents["rust-expert"].description).toBe(
      "Expert in Rust and systems programming",
    );
    expect(config.agents["code-reviewer"]).toBeDefined();
    expect(config.agents["rust-expert"].timeoutSeconds).toBe(30);
    expect(config.agents["code-reviewer"].timeoutSeconds).toBe(60);
    expect(config.connectionRequests.mode).toBe("deny");
  });

  it("throws on missing file", () => {
    expect(() => loadServerConfig("/nonexistent/path.toml")).toThrow();
  });
});

describe("loadServerConfig — auto mode", () => {
  it("parses connectionRequests.auto config", () => {
    const config = loadServerConfig(path.join(fixturesDir, "server-auto.toml"));

    expect(config.connectionRequests.mode).toBe("auto");
    expect(config.connectionRequests.auto).toBeDefined();
    expect(config.connectionRequests.auto!.model).toBe("your-model-id");
    expect(config.connectionRequests.auto!.apiKeyEnv).toBe("YOUR_PROVIDER_API_KEY");
    expect(config.connectionRequests.auto!.policy).toBe(
      "Accept connections from agents who have a clear reason.",
    );
  });

  it("has no auto config when mode is deny", () => {
    const config = loadServerConfig(path.join(fixturesDir, "server.toml"));
    expect(config.connectionRequests.mode).toBe("deny");
    expect(config.connectionRequests.auto).toBeUndefined();
  });
});

describe("loadFriendsConfig", () => {
  it("loads and parses friends.toml", () => {
    const config = loadFriendsConfig(path.join(fixturesDir, "friends.toml"));

    expect(config.friends["alice-agent"].fingerprint).toBe(
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(config.friends["alice-agent"].agents).toBeUndefined();
    expect(config.friends["carols-ml"].agents).toEqual(["rust-expert"]);
  });

  it("returns empty friends on missing file", () => {
    const config = loadFriendsConfig("/nonexistent/friends.toml");
    expect(config.friends).toEqual({});
  });
});

describe("config validation (zod)", () => {
  it("throws with a clear path when an agent is missing localEndpoint", () => {
    const file = writeTempToml(
      "server.toml",
      `
[server]
port = 9900
host = "0.0.0.0"
localPort = 9901

[agents.broken]
# localEndpoint missing — should fail validation with the offending path
rateLimit = "50/hour"
description = "broken"
`,
    );

    expect(() => loadServerConfig(file)).toThrowError(
      /agents\.broken\.localEndpoint/,
    );
  });

  it("throws when a friend fingerprint does not match the sha256 format", () => {
    const file = writeTempToml(
      "friends.toml",
      `
[friends.badfriend]
fingerprint = "not-a-real-fingerprint"
`,
    );

    expect(() => loadFriendsConfig(file)).toThrowError(
      /friends\.badfriend\.fingerprint/,
    );
  });
});

describe("validation config", () => {
  it("defaults to warn mode when omitted", () => {
    const parsed = ServerConfigSchema.parse({
      server: {
        port: 9900,
        host: "0.0.0.0",
        localPort: 9901,
        rateLimit: "100/hour",
        streamTimeoutSeconds: 300,
      },
    });
    expect(parsed.validation.mode).toBe("warn");
  });

  it("accepts enforce mode", () => {
    const parsed = ServerConfigSchema.parse({
      server: {
        port: 9900,
        host: "0.0.0.0",
        localPort: 9901,
        rateLimit: "100/hour",
        streamTimeoutSeconds: 300,
      },
      validation: { mode: "enforce" },
    });
    expect(parsed.validation.mode).toBe("enforce");
  });

  it("rejects invalid mode values", () => {
    const result = ServerConfigSchema.safeParse({
      server: {
        port: 9900,
        host: "0.0.0.0",
        localPort: 9901,
        rateLimit: "100/hour",
        streamTimeoutSeconds: 300,
      },
      validation: { mode: "panic" },
    });
    expect(result.success).toBe(false);
  });
});
