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
  fs.mkdirSync(aliceDir, { recursive: true });
  fs.mkdirSync(bobDir, { recursive: true });

  header("Generate identities");
  const alice = await generateIdentity({
    name: "alice-dev",
    certPath: path.join(aliceDir, "identity.crt"),
    keyPath: path.join(aliceDir, "identity.key"),
  });
  const bob = await generateIdentity({
    name: "rust-expert",
    certPath: path.join(bobDir, "identity.crt"),
    keyPath: path.join(bobDir, "identity.key"),
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

  header("Boot Bob's adapter + MCP client that auto-replies");
  const [bobClientT, bobServerT] = InMemoryTransport.createLinkedPair();
  const bobAdapter = await start({
    configDir: bobDir,
    agentName: "rust-expert",
    transport: bobServerT,
  });
  const bobClient = new Client({ name: "smoke-bob", version: "0.0.0" }, { capabilities: {} });
  await bobClient.connect(bobClientT);

  bobClient.setNotificationHandler(ChannelNotificationSchema, async (n) => {
    const meta = (n.params as any).meta ?? {};
    const contextId = meta.context_id;
    const peer = meta.peer;
    const inbound = n.params.content;
    await bobClient.callTool({
      name: "send",
      arguments: {
        peer,
        text: `auto-reply to: ${inbound}`,
        thread: contextId,
      },
    });
  });

  header("Boot Alice's adapter + MCP client that awaits reply");
  const [aliceClientT, aliceServerT] = InMemoryTransport.createLinkedPair();
  const aliceAdapter = await start({
    configDir: aliceDir,
    agentName: "alice-dev",
    transport: aliceServerT,
  });
  const aliceClient = new Client({ name: "smoke-alice", version: "0.0.0" }, { capabilities: {} });
  await aliceClient.connect(aliceClientT);

  let resolveReply: ((n: { content: string; meta: any }) => void) | null = null;
  const replyPromise = new Promise<{ content: string; meta: any }>((resolve) => {
    resolveReply = resolve;
  });
  aliceClient.setNotificationHandler(ChannelNotificationSchema, async (n) => {
    resolveReply?.({ content: n.params.content, meta: (n.params as any).meta });
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
    header("Alice → Bob (send tool)");
    const sendResult = await aliceClient.callTool({
      name: "send",
      arguments: { peer: "bobs-rust", text: "how do you handle errors in Rust?" },
    });
    if ((sendResult as any).isError) {
      throw new Error(
        `send errored: ${JSON.stringify((sendResult as any).content)}`,
      );
    }
    const sendData = JSON.parse(((sendResult as any).content[0] as any).text);
    ok(`ack context_id: ${sendData.context_id}`);

    header("Await Bob's auto-reply on Alice's channel");
    const reply = await Promise.race([
      replyPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("reply timeout (5s)")), 5000),
      ),
    ]);
    ok(`reply peer:       ${reply.meta.peer}`);
    ok(`reply context_id: ${reply.meta.context_id}`);
    ok(`reply body:       ${reply.content}`);
    if (reply.meta.context_id !== sendData.context_id) {
      throw new Error("reply context_id did not match outbound");
    }
    if (!reply.content.includes("auto-reply to:")) {
      throw new Error("reply did not flow through");
    }
  } finally {
    aliceCC.close();
    bobCC.close();
    await aliceAdapter.close();
    await bobAdapter.close();
    await aliceClient.close();
    await bobClient.close();
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
