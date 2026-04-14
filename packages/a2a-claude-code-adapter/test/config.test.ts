import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { loadAgentConfig } from "../src/config.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-config-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(contents: string): void {
  fs.writeFileSync(path.join(dir, "server.toml"), contents);
}

describe("loadAgentConfig", () => {
  it("reads the sole agent when no name is given", () => {
    write(`[server]
port = 29900
host = "0.0.0.0"
localPort = 29901

[agents.bob]
localEndpoint = "http://127.0.0.1:38800"
`);
    expect(loadAgentConfig(dir)).toEqual({
      agentName: "bob",
      port: 38800,
    });
  });

  it("picks the named agent when multiple exist", () => {
    write(`[agents.alice]
localEndpoint = "http://127.0.0.1:28800"

[agents.bob]
localEndpoint = "http://127.0.0.1:38800"
`);
    expect(loadAgentConfig(dir, "bob")).toEqual({
      agentName: "bob",
      port: 38800,
    });
  });

  it("fails when multiple agents exist and no name is given", () => {
    write(`[agents.alice]
localEndpoint = "http://127.0.0.1:28800"

[agents.bob]
localEndpoint = "http://127.0.0.1:38800"
`);
    expect(() => loadAgentConfig(dir)).toThrow(/--agent/);
  });

  it("fails when the named agent is missing", () => {
    write(`[agents.alice]
localEndpoint = "http://127.0.0.1:28800"
`);
    expect(() => loadAgentConfig(dir, "bob")).toThrow(/agent "bob" not found/);
  });

  it("fails when server.toml is missing", () => {
    expect(() => loadAgentConfig(dir)).toThrow(/server\.toml/);
  });

  it("fails when localEndpoint is not a valid URL", () => {
    write(`[agents.bob]
localEndpoint = "not-a-url"
`);
    expect(() => loadAgentConfig(dir, "bob")).toThrow(/localEndpoint/);
  });
});
