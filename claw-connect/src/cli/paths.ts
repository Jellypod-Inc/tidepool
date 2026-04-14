import path from "path";

interface CliRootOpts {
  configDir?: string;
}

type Env = Partial<Record<"CLAW_CONNECT_HOME" | "XDG_CONFIG_HOME" | "HOME", string>>;

export function resolveConfigDir(opts: CliRootOpts, env: Env = process.env): string {
  if (opts.configDir) return opts.configDir;
  if (env.CLAW_CONNECT_HOME) return env.CLAW_CONNECT_HOME;
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, "claw-connect");
  if (env.HOME) return path.join(env.HOME, ".config", "claw-connect");
  throw new Error(
    "Could not resolve config directory. Set --config-dir, CLAW_CONNECT_HOME, or HOME.",
  );
}
