import fs from "fs";
import path from "path";
import TOML from "@iarna/toml";
import { generateIdentity } from "claw-connect/identity";
import { E2E_ROOT, PERSONAS, personaDir, fingerprintFile } from "./e2e-personas.js";

async function main() {
  if (fs.existsSync(E2E_ROOT)) {
    fs.rmSync(E2E_ROOT, { recursive: true, force: true });
  }
  fs.mkdirSync(E2E_ROOT, { recursive: true });

  const fingerprints: Record<"alice" | "bob", string> = { alice: "", bob: "" };

  for (const p of Object.values(PERSONAS)) {
    const dir = personaDir(p);
    const agentDir = path.join(dir, "agents", p.agentName);
    fs.mkdirSync(agentDir, { recursive: true });

    const id = await generateIdentity({
      name: p.agentName,
      certPath: path.join(agentDir, "identity.crt"),
      keyPath: path.join(agentDir, "identity.key"),
    });
    fingerprints[p.key] = id.fingerprint;
    fs.writeFileSync(fingerprintFile(p), id.fingerprint);
    console.log(`[${p.key}] fingerprint: ${id.fingerprint}`);
  }

  for (const p of Object.values(PERSONAS)) {
    const dir = personaDir(p);
    const other = p.key === "alice" ? PERSONAS.bob : PERSONAS.alice;
    const otherFp = fingerprints[other.key];

    fs.writeFileSync(
      path.join(dir, "server.toml"),
      TOML.stringify({
        server: {
          port: p.publicPort,
          host: "0.0.0.0",
          localPort: p.localPort,
          rateLimit: "100/hour",
          streamTimeoutSeconds: 30,
        },
        agents: {
          [p.agentName]: {
            localEndpoint: `http://127.0.0.1:${p.adapterPort}`,
            rateLimit: "50/hour",
            description: `${p.key}'s claude-code-backed agent`,
            timeoutSeconds: 30,
          },
        },
        connectionRequests: { mode: "deny" },
        discovery: { providers: ["static"], cacheTtlSeconds: 300 },
        validation: { mode: "warn" },
      } as any),
    );

    fs.writeFileSync(
      path.join(dir, "friends.toml"),
      TOML.stringify({
        friends: {
          [p.localHandle]: { fingerprint: otherFp },
        },
      } as any),
    );
  }

  console.log(`\n✓ initialized ${E2E_ROOT}`);
  console.log(`  Next steps — in two panes:`);
  console.log(`    pane 1:  pnpm e2e:alice`);
  console.log(`    pane 2:  pnpm e2e:bob`);
  console.log(`  then see 'pnpm e2e:cheatsheet' for curl commands.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
