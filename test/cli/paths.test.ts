import { describe, it, expect } from "vitest";
import path from "path";
import os from "os";
import { resolveConfigDir } from "../../src/cli/paths.js";

describe("resolveConfigDir", () => {
  it("uses explicit --config-dir when provided", () => {
    expect(resolveConfigDir({ configDir: "/tmp/x" }, {})).toBe("/tmp/x");
  });

  it("falls back to TIDEPOOL_HOME", () => {
    expect(resolveConfigDir({}, { TIDEPOOL_HOME: "/tmp/y" })).toBe("/tmp/y");
  });

  it("falls back to XDG_CONFIG_HOME/tidepool", () => {
    expect(resolveConfigDir({}, { XDG_CONFIG_HOME: "/tmp/cfg" })).toBe(
      "/tmp/cfg/tidepool",
    );
  });

  it("falls back to $HOME/.config/tidepool", () => {
    expect(resolveConfigDir({}, { HOME: "/home/alice" })).toBe(
      "/home/alice/.config/tidepool",
    );
  });

  it("throws when no home is resolvable", () => {
    expect(() => resolveConfigDir({}, {})).toThrow(/config directory/i);
  });

  it("--config-dir beats all env vars", () => {
    expect(
      resolveConfigDir(
        { configDir: "/explicit" },
        { TIDEPOOL_HOME: "/env", HOME: "/home/a" },
      ),
    ).toBe("/explicit");
  });
});
