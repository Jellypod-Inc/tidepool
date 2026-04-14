import { pingAgent, formatPingResult } from "../ping.js";

interface RunPingOpts {
  url: string;
}

export async function runPing(opts: RunPingOpts): Promise<string> {
  const result = await pingAgent(opts.url);
  return formatPingResult(opts.url, result);
}
