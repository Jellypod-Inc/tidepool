import { AgentCardSchema } from "./a2a.js";

export interface PingResult {
  reachable: boolean;
  name?: string;
  description?: string;
  skills?: { id: string; name: string; description: string }[];
  latencyMs?: number;
  error?: string;
}

export async function pingAgent(agentCardUrl: string): Promise<PingResult> {
  const start = Date.now();

  try {
    const response = await fetch(agentCardUrl, {
      signal: AbortSignal.timeout(10000),
    });

    const latencyMs = Date.now() - start;

    if (!response.ok) {
      return {
        reachable: false,
        latencyMs,
        error: `HTTP ${response.status} ${response.statusText}`,
      };
    }

    const data = await response.json();
    const parsed = AgentCardSchema.safeParse(data);

    if (!parsed.success) {
      return {
        reachable: false,
        latencyMs,
        error: "Response is not a valid Agent Card (missing name)",
      };
    }

    return {
      reachable: true,
      name: parsed.data.name,
      description: parsed.data.description,
      skills: parsed.data.skills.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
      })),
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    return {
      reachable: false,
      latencyMs,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

export function formatPingResult(url: string, result: PingResult): string {
  const lines: string[] = [];

  if (result.reachable) {
    lines.push(`REACHABLE  ${result.name} (${result.latencyMs}ms)`);
    lines.push(`  URL: ${url}`);
    if (result.description) {
      lines.push(`  Description: ${result.description}`);
    }
    if (result.skills && result.skills.length > 0) {
      lines.push(`  Skills:`);
      for (const skill of result.skills) {
        lines.push(`    - ${skill.name}: ${skill.description}`);
      }
    }
  } else {
    lines.push(`UNREACHABLE  ${url}`);
    if (result.error) lines.push(`  Error: ${result.error}`);
    if (result.latencyMs !== undefined) {
      lines.push(`  Latency: ${result.latencyMs}ms`);
    }
  }

  return lines.join("\n");
}
