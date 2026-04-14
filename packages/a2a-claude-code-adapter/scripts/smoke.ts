import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import TOML from "@iarna/toml";
import { z } from "zod";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { generateIdentity } from "../../claw-connect/src/identity.js";
import { startServer } from "../../claw-connect/src/server.js";
import { start } from "../src/start.js";

const ChannelNotificationSchema = z.object({
  method: z.literal("notifications/claude/channel"),
  params: z.object({
    content: z.string(),
    meta: z.any().optional(),
  }),
});

const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const header = (s: string) => console.log(`\n\x1b[1;36m=== ${s} ===\x1b[0m`);

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-smoke-"));
  const aliceDir = path.join(tmp, "alice");
  const bobDir = path.join(tmp, "bob");
  fs.mkdirSync(path.join(aliceDir, "agents/alice-dev"), { recursive: true });
  fs.mkdirSync(path.join(bobDir, "agents/rust-expert"), { recursive: true });

  header("Generate identities");
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
  ok(`alice: ${alice.fingerprint.slice(0, 24)}…`);
  ok(`bob:   ${bob.fingerprint.slice(0, 24)}…`);

  header("Write configs");
  fs.writeFileSync(
    path.join(aliceDir, "server.toml"),
    TOML.stringify({
      server: { port: 19900, host: "0.0.0.0", localPort: 19901, rateLimit: "100/hour", streamTimeoutSeconds: 30 },
      agents: { "alice-dev": { localEndpoint: "http://127.0.0.1:28800", rateLimit: "50/hour", description: "Alice", timeoutSeconds: 30 } },
      connectionRequests: { mode: "deny" },
      discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      validation: { mode: "warn" },
    } as any),
  );
  fs.writeFileSync(
    path.join(aliceDir, "friends.toml"),
    TOML.stringify({ friends: { "bobs-rust": { fingerprint: bob.fingerprint } } } as any),
  );
  fs.writeFileSync(
    path.join(bobDir, "server.toml"),
    TOML.stringify({
      server: { port: 29900, host: "0.0.0.0", localPort: 29901, rateLimit: "100/hour", streamTimeoutSeconds: 30 },
      agents: { "rust-expert": { localEndpoint: "http://127.0.0.1:38800", rateLimit: "50/hour", description: "Bob", timeoutSeconds: 30 } },
      connectionRequests: { mode: "deny" },
      discovery: { providers: ["static"], cacheTtlSeconds: 300 },
      validation: { mode: "warn" },
    } as any),
  );
  fs.writeFileSync(
    path.join(bobDir, "friends.toml"),
    TOML.stringify({ friends: { alice: { fingerprint: alice.fingerprint } } } as any),
  );

  header("Boot Bob's adapter with an in-memory MCP client that auto-replies");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const bobAdapter = await start({
    configDir: bobDir,
    agentName: "rust-expert",
    replyTimeoutMs: 5_000,
    transport: serverT,
  });
  const client = new Client({ name: "smoke", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientT);

  client.setNotificationHandler(ChannelNotificationSchema, async (n) => {
    const taskId = (n.params as any).meta.task_id;
    const inbound = n.params.content;
    await client.callTool({
      name: "a2a_reply",
      arguments: { task_id: taskId, text: `auto-reply to: ${inbound}` },
    });
  });

  header("Boot Bob's claw-connect");
  const bobCC = await startServer({
    configDir: bobDir,
    remoteAgents: [
      {
        localHandle: "alice",
        remoteEndpoint: "https://127.0.0.1:19900",
        remoteTenant: "alice-dev",
        certFingerprint: alice.fingerprint,
      },
    ],
  });

  header("Boot Alice's claw-connect");
  const aliceCC = await startServer({
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

  try {
    header("Alice → Bob (message:send)");
    const res = await fetch("http://127.0.0.1:19901/bobs-rust/message:send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          messageId: "smoke-1",
          role: "user",
          parts: [{ kind: "text", text: "how do you handle errors in Rust?" }],
        },
      }),
    });
    const body = (await res.json()) as any;
    ok(`status: ${body.status.state}`);
    ok(`body:   ${body.artifacts[0].parts[0].text}`);
    if (body.status.state !== "completed") throw new Error("expected completed");
    if (!String(body.artifacts[0].parts[0].text).includes("auto-reply to:")) {
      throw new Error("reply did not flow through");
    }
  } finally {
    aliceCC.close();
    bobCC.close();
    await bobAdapter.close();
    await client.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log("\n\x1b[32mSMOKE PASSED\x1b[0m\n");
}

main().then(
  () => setTimeout(() => process.exit(0), 100),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
