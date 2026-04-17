import path from "path";

interface CliRootOpts {
  configDir?: string;
}

type Env = Partial<Record<"TIDEPOOL_HOME" | "XDG_CONFIG_HOME" | "HOME", string>>;

export function resolveConfigDir(opts: CliRootOpts, env: Env = process.env): string {
  if (opts.configDir) return opts.configDir;
  if (env.TIDEPOOL_HOME) return env.TIDEPOOL_HOME;
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, "tidepool");
  if (env.HOME) return path.join(env.HOME, ".config", "tidepool");
  throw new Error(
    "Could not resolve config directory. Set --config-dir, TIDEPOOL_HOME, or HOME.",
  );
}
