import fs from "fs";
import { startServer } from "claw-connect/server";
import { start as startAdapter } from "a2a-claude-code-adapter/server";
import { PERSONAS, personaDir, fingerprintFile } from "./e2e-personas.js";

async function main() {
  const key = process.argv[2];
  if (key !== "alice" && key !== "bob") {
    console.error("usage: e2e-run <alice|bob>");
    process.exit(1);
  }
  const me = PERSONAS[key];
  const other = key === "alice" ? PERSONAS.bob : PERSONAS.alice;
  const dir = personaDir(me);

  if (!fs.existsSync(dir)) {
    console.error(`missing ${dir} — run \`pnpm e2e:init\` first`);
    process.exit(1);
  }

  const otherFp = fs.readFileSync(fingerprintFile(other), "utf8").trim();

  process.stderr.write(
    `\n[${me.key}] booting\n` +
      `  claw-connect public :  https://127.0.0.1:${me.publicPort}\n` +
      `  claw-connect local  :  http://127.0.0.1:${me.localPort}\n` +
      `  adapter             :  http://127.0.0.1:${me.adapterPort}\n\n`,
  );

  const cc = await startServer({
    configDir: dir,
    remoteAgents: [
      {
        localHandle: other.key,
        remoteEndpoint: `https://127.0.0.1:${other.publicPort}`,
        remoteTenant: other.agentName,
        certFingerprint: otherFp,
      },
    ],
  });

  const adapter = startAdapter({
    port: me.adapterPort,
    host: "127.0.0.1",
    replyTimeoutMs: 10 * 60_000,
  });

  process.stderr.write(
    `[${me.key}] ready. Inbound A2A messages to this persona's agent will print\n` +
      `         as JSON lines on stdout below. Reply with:\n` +
      `         curl -X POST http://127.0.0.1:${me.adapterPort}/__control/reply/<taskId> \\\n` +
      `              -H 'Content-Type: application/json' -d '{"text":"..."}'\n\n` +
      `[${me.key}] to send ${me.key} → ${other.key} from another pane:\n` +
      `         curl -X POST http://127.0.0.1:${me.localPort}/${other.key}/message:send \\\n` +
      `              -H 'Content-Type: application/json' \\\n` +
      `              -d '{"message":{"messageId":"m1","role":"user","parts":[{"kind":"text","text":"hi ${other.key}"}]}}'\n\n`,
  );

  const shutdown = async (sig: string) => {
    process.stderr.write(`\n[${me.key}] received ${sig}, shutting down\n`);
    try {
      cc.close();
    } catch {}
    try {
      await adapter.close();
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
