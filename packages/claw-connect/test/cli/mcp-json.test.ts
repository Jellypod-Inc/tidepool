import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { ensureMcpJsonEntry } from "../../src/cli/mcp-json.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-mcp-"));
}

describe("ensureMcpJsonEntry", () => {
  it("creates .mcp.json when absent", async () => {
    const cwd = tmp();
    const result = await ensureMcpJsonEntry({ cwd, agentName: "donkey" });
    expect(result).toEqual({ action: "created", previousAgent: null });

    const content = JSON.parse(fs.readFileSync(path.join(cwd, ".mcp.json"), "utf-8"));
    expect(content.mcpServers.a2a).toEqual({
      command: "a2a-claude-code-adapter",
      args: ["--agent", "donkey"],
    });
  });

  it("preserves other mcpServers when merging", async () => {
    const cwd = tmp();
    fs.writeFileSync(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          other: { command: "foo", args: ["bar"] },
        },
      }),
    );
    await ensureMcpJsonEntry({ cwd, agentName: "donkey" });
    const content = JSON.parse(fs.readFileSync(path.join(cwd, ".mcp.json"), "utf-8"));
    expect(content.mcpServers.other).toEqual({ command: "foo", args: ["bar"] });
    expect(content.mcpServers.a2a).toEqual({
      command: "a2a-claude-code-adapter",
      args: ["--agent", "donkey"],
    });
  });

  it("overwrites args when existing a2a points at a different agent", async () => {
    const cwd = tmp();
    fs.writeFileSync(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          a2a: { command: "a2a-claude-code-adapter", args: ["--agent", "zebra"] },
        },
      }),
    );
    const result = await ensureMcpJsonEntry({ cwd, agentName: "donkey" });
    expect(result).toEqual({ action: "updated", previousAgent: "zebra" });
    const content = JSON.parse(fs.readFileSync(path.join(cwd, ".mcp.json"), "utf-8"));
    expect(content.mcpServers.a2a.args).toEqual(["--agent", "donkey"]);
  });

  it("no-ops when args already match", async () => {
    const cwd = tmp();
    fs.writeFileSync(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          a2a: { command: "a2a-claude-code-adapter", args: ["--agent", "donkey"] },
        },
      }),
    );
    const result = await ensureMcpJsonEntry({ cwd, agentName: "donkey" });
    expect(result).toEqual({ action: "unchanged", previousAgent: "donkey" });
  });

  it("refuses to parse invalid JSON", async () => {
    const cwd = tmp();
    fs.writeFileSync(path.join(cwd, ".mcp.json"), "{ not json");
    await expect(ensureMcpJsonEntry({ cwd, agentName: "donkey" })).rejects.toThrow(/\.mcp\.json/);
  });
});
