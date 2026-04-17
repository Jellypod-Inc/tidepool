import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../src/server.js";
import { runInit } from "../src/cli/init.js";

describe("public interface delivery via session registry", () => {
  it("returns 503 agent_offline via local interface when no session is registered", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-offline-"));
    await runInit({ configDir: dir });
    // Override ports to avoid conflicts with other test files
    fs.writeFileSync(
      path.join(dir, "server.toml"),
      `[server]\nport = 57720\nhost = "127.0.0.1"\nlocalPort = 57722\nrateLimit = "1000/hour"\nstreamTimeoutSeconds = 30\n[connectionRequests]\nmode = "deny"\n[discovery]\nproviders = ["static"]\ncacheTtlSeconds = 300\n[validation]\nmode = "warn"\n`,
    );
    const handle = await startServer({ configDir: dir });
    const localPort = (handle.localServer.address() as any).port;

    try {
      const res = await fetch(
        `http://127.0.0.1:${localPort}/alice/.well-known/agent-card.json`,
      );
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error.code).toBe("agent_offline");
    } finally {
      handle.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
