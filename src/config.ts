import fs from "fs";
import TOML from "@iarna/toml";
import { z } from "zod";
import { ServerConfigSchema } from "./schemas.js";
import type { ServerConfig } from "./types.js";

function formatZodError(err: z.ZodError, filePath: string): Error {
  // Build a human-readable path → problem summary. The first issue is
  // usually the one that matters most for config debugging.
  const lines = err.issues.map((i) => {
    const path =
      i.path.length > 0 ? i.path.map(String).join(".") : "<root>";
    return `  ${path}: ${i.message}`;
  });
  return new Error(`Invalid config at ${filePath}:\n${lines.join("\n")}`);
}

// @iarna/toml decorates parsed tables with Symbol-keyed metadata (type and
// declared markers). zod's record schemas iterate all own keys including
// symbols and fail on them. Round-trip through JSON to drop the symbols.
function stripSymbolKeys(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

export function loadServerConfig(filePath: string): ServerConfig {
  const content = fs.readFileSync(filePath, "utf-8");
  const parsed = stripSymbolKeys(TOML.parse(content));

  const result = ServerConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw formatZodError(result.error, filePath);
  }

  // The schema output type is structurally compatible with ServerConfig but
  // not identical (e.g. optional-vs-present defaults). Cast at the seam.
  return result.data as unknown as ServerConfig;
}

