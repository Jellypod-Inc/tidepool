import path from "path";

export type Persona = {
  key: "alice" | "bob";
  agentName: string;
  localHandle: string;
  publicPort: number;
  localPort: number;
  adapterPort: number;
};

export const PERSONAS: Record<"alice" | "bob", Persona> = {
  alice: {
    key: "alice",
    agentName: "alice-dev",
    localHandle: "bob",
    publicPort: 19900,
    localPort: 19901,
    adapterPort: 28800,
  },
  bob: {
    key: "bob",
    agentName: "rust-expert",
    localHandle: "alice",
    publicPort: 29900,
    localPort: 29901,
    adapterPort: 38800,
  },
};

export const E2E_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  ".local-e2e",
);

export const personaDir = (p: Persona) => path.join(E2E_ROOT, p.key);
export const fingerprintFile = (p: Persona) =>
  path.join(personaDir(p), "fingerprint.txt");
