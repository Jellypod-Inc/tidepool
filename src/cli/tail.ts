import path from "path";
import { loadServerConfig } from "../config.js";
import { fail } from "./output.js";

export interface RunTailOpts {
  configDir: string;
  follow?: boolean;
}

interface TapEvent {
  ts: number;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  action: string;
  contextId?: string;
  messageId?: string;
  text?: string;
}

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

function useColor(): boolean {
  return process.stdout.isTTY === true && process.env.NO_COLOR !== "1";
}

function paint(s: string, color: keyof typeof COLORS): string {
  return useColor() ? `${COLORS[color]}${s}${COLORS.reset}` : s;
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function render(event: TapEvent): string {
  const arrow = event.direction === "inbound"
    ? paint("←", "green")
    : paint("→", "cyan");
  const ctx = event.contextId ? paint(` ctx=${event.contextId.slice(0, 8)}`, "dim") : "";
  const header = `${paint(formatTs(event.ts), "dim")}  ${arrow} ${paint(event.from, "bold")} ${paint("→", "dim")} ${paint(event.to, "bold")}  ${paint(event.action, "yellow")}${ctx}`;
  const body = event.text ? `\n  ${event.text.replace(/\n/g, "\n  ")}` : "";
  return header + body;
}

export async function runTail(opts: RunTailOpts): Promise<void> {
  const cfg = loadServerConfig(path.join(opts.configDir, "server.toml"));
  const localPort = cfg.server.localPort;
  const url = `http://127.0.0.1:${localPort}/internal/tail`;

  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: "text/event-stream" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`Could not connect to tidepool daemon at ${url}: ${msg}\nIs the daemon running? Try 'tidepool status'.`);
  }

  if (!res.ok || !res.body) {
    fail(`Daemon responded ${res.status} ${res.statusText} at ${url}`);
  }

  process.stdout.write(paint(`Tailing ${url} — Ctrl-C to stop\n\n`, "dim"));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const dataLines = frame
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6));
      if (dataLines.length === 0) continue;
      const payload = dataLines.join("\n");
      try {
        const event = JSON.parse(payload) as TapEvent;
        process.stdout.write(render(event) + "\n");
      } catch {
        // ignore malformed frames
      }
    }
  }
}
