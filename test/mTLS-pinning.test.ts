import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import express from "express";
import TOML from "@iarna/toml";
import { generateIdentity } from "../src/identity.js";
import { startServer } from "../src/server.js";

// Minimal A2A echo agent — used by both the real Bob and the impersonator Mallory.
function createMockAgent(port: number, name: string): http.Server {
  const app = express();
  app.use(express.json());

  app.post("/message\\:send", (_req, res) => {
    res.json({
      id: `task-${name}`,
      contextId: `ctx-${name}`,
      status: { state: "completed" },
      artifacts: [
        {
          artifactId: "response",
          parts: [{ kind: "text", text: `${name} responded` }],
        },
      ],
    });
  });

  return app.listen(port, "127.0.0.1");
}

/**
 * Outbound mTLS fingerprint pinning
 *
 * Scenario: Alice has a remote-agent config for "bobs-rust" pinned to Bob's
 * fingerprint. An impersonator (Mallory) is listening on the endpoint Alice
 * thinks is Bob. Mallory presents a valid mTLS-capable cert that is NOT Bob's.
 *
 * Expected: Alice's outbound call MUST fail (cert fingerprint mismatch).
 * Current behavior (pre-fix): Alice accepts any cert → proxies to Mallory
 * → Mallory responds 200 → silent MITM success.
 */
describe("outbound mTLS fingerprint pinning", () => {
  let tmpDir: string;
  let aliceConfigDir: string;
  let malloryConfigDir: string;
  let aliceMockAgent: http.Server;
  let malloryMockAgent: http.Server;
  let aliceServer: { close: () => void };
  let malloryServer: { close: () => void };

  // Ports — chosen to avoid collision with e2e.test.ts
  const ALICE_PUBLIC = 49901;
  const ALICE_LOCAL = 49902;
  const MALLORY_PUBLIC = 49903;
  const ALICE_MOCK = 49904;
  const MALLORY_MOCK = 49905;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-mtls-pin-"));

    // --- Identities ---
    aliceConfigDir = path.join(tmpDir, "alice");
    malloryConfigDir = path.join(tmpDir, "mallory");

    const aliceIdentity = await generateIdentity({
      name: "alice-dev",
      certPath: path.join(aliceConfigDir, "identity.crt"),
      keyPath: path.join(aliceConfigDir, "identity.key"),
    });

    // Bob's identity — generated but NEVER used to stand up a server.
    // Its fingerprint is what Alice pins; the point of the test is that
    // the thing actually listening on the endpoint (Mallory) has a
    // DIFFERENT fingerprint, so Alice must reject the connection.
    const bobIdentity = await generateIdentity({
      name: "rust-expert",
      certPath: path.join(tmpDir, "bob-unused.crt"),
      keyPath: path.join(tmpDir, "bob-unused.key"),
    });

    // Mallory's identity — the impersonator actually running on the endpoint.
    const malloryIdentity = await generateIdentity({
      name: "rust-expert",
      certPath: path.join(malloryConfigDir, "identity.crt"),
      keyPath: path.join(malloryConfigDir, "identity.key"),
    });

    // Sanity check: test is only meaningful if Bob and Mallory differ.
    expect(bobIdentity.fingerprint).not.toBe(malloryIdentity.fingerprint);

    // --- Alice's config ---
    fs.writeFileSync(
      path.join(aliceConfigDir, "server.toml"),
      TOML.stringify({
        server: {
          port: ALICE_PUBLIC,
          host: "0.0.0.0",
          localPort: ALICE_LOCAL,
          rateLimit: "100/hour",
          streamTimeoutSeconds: 10,
        },
        agents: {
          "alice-dev": {
            localEndpoint: `http://127.0.0.1:${ALICE_MOCK}`,
            rateLimit: "50/hour",
            description: "Alice's dev agent",
            timeoutSeconds: 5,
          },
        },
        connectionRequests: { mode: "deny" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      } as any),
    );

    // Alice's friends — irrelevant for this test, but required.
    fs.writeFileSync(
      path.join(aliceConfigDir, "friends.toml"),
      TOML.stringify({ friends: {} } as any),
    );

    // --- Mallory's config (pretends to be Bob) ---
    fs.writeFileSync(
      path.join(malloryConfigDir, "server.toml"),
      TOML.stringify({
        server: {
          port: MALLORY_PUBLIC,
          host: "0.0.0.0",
          localPort: 49906,
          rateLimit: "100/hour",
          streamTimeoutSeconds: 10,
        },
        agents: {
          "rust-expert": {
            localEndpoint: `http://127.0.0.1:${MALLORY_MOCK}`,
            rateLimit: "50/hour",
            description: "NOT ACTUALLY BOB",
            timeoutSeconds: 5,
          },
        },
        connectionRequests: { mode: "deny" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      } as any),
    );

    // Mallory accepts Alice as a friend — so if Alice DOES complete the TLS
    // handshake, Mallory will happily serve her request. This is what makes
    // the MITM scenario realistic: Mallory is a well-configured impersonator,
    // not a broken server. The ONLY thing that should stop Alice is her own
    // outbound fingerprint check.
    fs.writeFileSync(
      path.join(malloryConfigDir, "friends.toml"),
      TOML.stringify({
        friends: {
          alice: { fingerprint: aliceIdentity.fingerprint },
        },
      } as any),
    );

    // --- Mock agents ---
    aliceMockAgent = createMockAgent(ALICE_MOCK, "alice-dev");
    malloryMockAgent = createMockAgent(MALLORY_MOCK, "MALLORY");

    // --- Start Tidepool servers ---
    aliceServer = await startServer({
      configDir: aliceConfigDir,
      remoteAgents: [
        {
          localHandle: "bobs-rust",
          // Alice thinks this endpoint is Bob. It is actually Mallory.
          remoteEndpoint: `https://127.0.0.1:${MALLORY_PUBLIC}`,
          remoteTenant: "rust-expert",
          // Alice pins Bob's fingerprint — the real thing she expects.
          certFingerprint: bobIdentity.fingerprint,
        },
      ],
    });

    malloryServer = await startServer({
      configDir: malloryConfigDir,
      remoteAgents: [],
    });
  });

  afterAll(() => {
    aliceMockAgent?.close();
    malloryMockAgent?.close();
    aliceServer?.close();
    malloryServer?.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("rejects outbound requests when peer cert fingerprint does not match pinned value", async () => {
    const response = await fetch(
      `http://127.0.0.1:${ALICE_LOCAL}/bobs-rust/message:send`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agent": "alice-dev",
        },
        body: JSON.stringify({
          message: {
            messageId: "mtls-pin-1",
            role: "user",
            parts: [{ kind: "text", text: "Hello Bob" }],
          },
        }),
      },
    );

    // A successful proxy to Mallory (i.e. 2xx with Mallory's artifact)
    // means Alice silently accepted a MITM. That MUST NOT happen.
    expect(response.ok).toBe(false);

    // The current error path in src/server.ts wraps upstream failure as 504.
    // We care that the request was rejected, not the exact code — but 504
    // is the expected shape given the existing catch branch.
    expect(response.status).toBeGreaterThanOrEqual(500);

    const body = await response.json() as any;
    // Ensure we did NOT get Mallory's artifact (which would prove MITM succeeded).
    const text = JSON.stringify(body);
    expect(text).not.toContain("MALLORY responded");
  });
});
