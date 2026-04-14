import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runInit } from "../../src/cli/init.js";
import { runRemoteAdd, runRemoteList, runRemoteRemove } from "../../src/cli/remote.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-remote-"));
}

const FP = "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

describe("remote add/list/remove", () => {
  it("round-trips a remote agent through add/list/remove", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });

    await runRemoteAdd({
      configDir: dir,
      localHandle: "bobs-rust",
      remoteEndpoint: "https://127.0.0.1:29900",
      remoteTenant: "rust-expert",
      certFingerprint: FP,
    });

    const listed = await runRemoteList({ configDir: dir });
    expect(listed).toEqual([
      {
        localHandle: "bobs-rust",
        remoteEndpoint: "https://127.0.0.1:29900",
        remoteTenant: "rust-expert",
        certFingerprint: FP,
      },
    ]);

    await runRemoteRemove({ configDir: dir, localHandle: "bobs-rust" });
    expect(await runRemoteList({ configDir: dir })).toEqual([]);
  });

  it("rejects a bad fingerprint", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    await expect(
      runRemoteAdd({
        configDir: dir,
        localHandle: "x",
        remoteEndpoint: "https://h:1",
        remoteTenant: "t",
        certFingerprint: "not-a-fingerprint",
      }),
    ).rejects.toThrow();
  });
});
