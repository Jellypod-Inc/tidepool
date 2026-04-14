/**
 * End-to-end smoke test: two Claw Connect servers (Alice, Bob) talking to each
 * other through real mTLS, with two mock upstream agents behind them.
 *
 * Run with: pnpm smoke
 *
 * Exercises happy paths:
 *   1. Alice's local UI → Alice's Claw Connect → Bob's Claw Connect → Bob's agent (message:send).
 *   2. Bob's local UI → Bob's Claw Connect → Alice's Claw Connect → Alice's agent (message:send).
 *   3. Streaming: same hop, but message:stream — exercises proxySSEStream and upstream event validation.
 *
 * Watches for `[wire-validation]` lines in stderr. A healthy run emits zero of them.
 */
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import express from "express";
import TOML from "@iarna/toml";
import { generateIdentity } from "../src/identity.js";
import { startServer } from "../src/server.js";
import { formatSseEvent } from "../src/a2a.js";

const header = (s: string) => console.log(`\n\x1b[1;36m=== ${s} ===\x1b[0m`);
const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);

function createMockAgent(port: number, name: string): http.Server {
  const app = express();
  app.use(express.json());

  app.post("/message\\:send", (req, res) => {
    const userMessage = req.body?.message?.parts?.[0]?.text ?? "(no text)";
    res.json({
      id: `task-${name}`,
      contextId: `ctx-${name}`,
      status: { state: "completed" },
      artifacts: [
        {
          artifactId: "response",
          parts: [{ kind: "text", text: `${name} received: ${userMessage}` }],
        },
      ],
    });
  });

  app.post("/message\\:stream", (req, res) => {
    const userMessage = req.body?.message?.parts?.[0]?.text ?? "(no text)";
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(
      formatSseEvent({
        kind: "status-update",
        taskId: `task-${name}`,
        contextId: `ctx-${name}`,
        status: { state: "working" },
      }),
    );
    res.write(
      formatSseEvent({
        kind: "artifact-update",
        taskId: `task-${name}`,
        contextId: `ctx-${name}`,
        artifact: {
          artifactId: "response",
          parts: [{ kind: "text", text: `${name} streaming back: ${userMessage}` }],
        },
      }),
    );
    res.write(
      formatSseEvent({
        kind: "status-update",
        taskId: `task-${name}`,
        contextId: `ctx-${name}`,
        status: { state: "completed" },
      }),
    );
    res.end();
  });

  return app.listen(port, "127.0.0.1");
}

async function main() {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    if (line.startsWith("[wire-validation]")) warnings.push(line);
    origWarn(...args);
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-smoke-"));
  const aliceDir = path.join(tmp, "alice");
  const bobDir = path.join(tmp, "bob");
  fs.mkdirSync(path.join(aliceDir, "agents/alice-dev"), { recursive: true });
  fs.mkdirSync(path.join(bobDir, "agents/rust-expert"), { recursive: true });

  header("Generating identities");
  const alice = await generateIdentity({
    name: "alice-dev",
    certPath: path.join(aliceDir, "agents/alice-dev/identity.crt"),
    keyPath: path.join(aliceDir, "agents/alice-dev/identity.key"),
  });
  const bob = await generateIdentity({
    name: "rust-expert",
    certPath: path.join(bobDir, "agents/rust-expert/identity.crt"),
    keyPath: path.join(bobDir, "agents/rust-expert/identity.key"),
  });
  ok(`Alice fingerprint: ${alice.fingerprint.slice(0, 24)}…`);
  ok(`Bob   fingerprint: ${bob.fingerprint.slice(0, 24)}…`);

  header("Writing configs");
  fs.writeFileSync(
    path.join(aliceDir, "server.toml"),
    TOML.stringify({
      server: { port: 19900, host: "0.0.0.0", localPort: 19901, rateLimit: "100/hour", streamTimeoutSeconds: 30 },
      agents: { "alice-dev": { localEndpoint: "http://127.0.0.1:28800", rateLimit: "50/hour", description: "Alice's dev agent", timeoutSeconds: 10 } },
      connectionRequests: { mode: "deny" },
      discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      validation: { mode: "warn" },
    } as any),
  );
  fs.writeFileSync(
    path.join(aliceDir, "friends.toml"),
    TOML.stringify({ friends: { "bobs-rust-expert": { fingerprint: bob.fingerprint } } } as any),
  );
  fs.writeFileSync(
    path.join(bobDir, "server.toml"),
    TOML.stringify({
      server: { port: 29900, host: "0.0.0.0", localPort: 29901, rateLimit: "100/hour", streamTimeoutSeconds: 30 },
      agents: { "rust-expert": { localEndpoint: "http://127.0.0.1:38800", rateLimit: "50/hour", description: "Bob's Rust expert", timeoutSeconds: 10 } },
      connectionRequests: { mode: "deny" },
      discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      validation: { mode: "warn" },
    } as any),
  );
  fs.writeFileSync(
    path.join(bobDir, "friends.toml"),
    TOML.stringify({ friends: { "alices-dev": { fingerprint: alice.fingerprint } } } as any),
  );
  ok("Alice: 19900 public / 19901 local");
  ok("Bob:   29900 public / 29901 local");

  header("Starting mock upstream agents");
  const aliceMock = createMockAgent(28800, "alice-dev");
  const bobMock = createMockAgent(38800, "rust-expert");
  ok("Alice's agent on 28800");
  ok("Bob's agent on 38800");

  header("Starting Claw Connect servers");
  const aliceServer = await startServer({
    configDir: aliceDir,
    remoteAgents: [
      {
        localHandle: "bobs-rust",
        remoteEndpoint: "https://127.0.0.1:29900",
        remoteTenant: "rust-expert",
        certFingerprint: bob.fingerprint,
      },
    ],
  });
  const bobServer = await startServer({
    configDir: bobDir,
    remoteAgents: [
      {
        localHandle: "alices-dev",
        remoteEndpoint: "https://127.0.0.1:19900",
        remoteTenant: "alice-dev",
        certFingerprint: alice.fingerprint,
      },
    ],
  });

  try {
    header("1. Alice → Bob (message:send)");
    const r1 = await fetch("http://127.0.0.1:19901/bobs-rust/message:send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          messageId: "smoke-1",
          role: "user",
          parts: [{ kind: "text", text: "How do you handle errors in Rust?" }],
        },
      }),
    });
    const d1 = (await r1.json()) as any;
    ok(`status: ${d1.status.state}`);
    ok(`body:   ${d1.artifacts[0].parts[0].text}`);

    header("2. Bob → Alice (message:send)");
    const r2 = await fetch("http://127.0.0.1:29901/alices-dev/message:send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          messageId: "smoke-2",
          role: "user",
          parts: [{ kind: "text", text: "What are you working on?" }],
        },
      }),
    });
    const d2 = (await r2.json()) as any;
    ok(`status: ${d2.status.state}`);
    ok(`body:   ${d2.artifacts[0].parts[0].text}`);

    header("3. Alice → Bob (message:stream)");
    const r3 = await fetch("http://127.0.0.1:19901/bobs-rust/message:stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          messageId: "smoke-3",
          role: "user",
          parts: [{ kind: "text", text: "stream me something" }],
        },
      }),
    });
    if (!r3.body) throw new Error("no stream body");
    const text = await r3.text();
    const events = text
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)));
    ok(`received ${events.length} events`);
    for (const ev of events) {
      const kind = ev.kind;
      if (kind === "status-update") ok(`  status-update → ${ev.status?.state}`);
      else if (kind === "artifact-update") ok(`  artifact-update → ${ev.artifact?.parts?.[0]?.text}`);
      else ok(`  ${kind}`);
    }

    header("Agent Card");
    const r4 = await fetch("http://127.0.0.1:19901/.well-known/agent-card.json");
    const card = (await r4.json()) as any;
    ok(`name: ${card.name}`);
    ok(`skills: ${card.skills.map((s: any) => s.id).join(", ")}`);
  } finally {
    aliceServer.close();
    bobServer.close();
    aliceMock.close();
    bobMock.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  header("Validation log summary");
  if (warnings.length === 0) {
    ok("zero [wire-validation] lines — happy paths emitted fully-conforming payloads");
  } else {
    console.log(`  \x1b[33m⚠\x1b[0m  ${warnings.length} [wire-validation] line(s):`);
    for (const w of warnings) console.log(`     ${w}`);
  }

  console.log();
}

main().then(
  () => setTimeout(() => process.exit(0), 100),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
