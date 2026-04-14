import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runInit } from "../../src/cli/init.js";
import {
  runFriendAdd,
  runFriendList,
  runFriendRemove,
} from "../../src/cli/friend.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-friend-"));
}

const FP =
  "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const FP2 =
  "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

describe("friend add/list/remove", () => {
  it("add appends to friends.toml; list returns what was added; remove removes it", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });

    await runFriendAdd({ configDir: dir, handle: "bob", fingerprint: FP });
    const listed = await runFriendList({ configDir: dir });
    expect(listed).toEqual([{ handle: "bob", fingerprint: FP }]);

    await runFriendRemove({ configDir: dir, handle: "bob" });
    const after = await runFriendList({ configDir: dir });
    expect(after).toEqual([]);
  });

  it("add with --scope restricts visible agents", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    await runFriendAdd({
      configDir: dir,
      handle: "carol",
      fingerprint: FP,
      agents: ["alice-dev", "rust-expert"],
    });
    const [entry] = await runFriendList({ configDir: dir });
    expect(entry.agents).toEqual(["alice-dev", "rust-expert"]);
  });

  it("add rejects duplicate handles", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    await runFriendAdd({ configDir: dir, handle: "bob", fingerprint: FP });
    await expect(
      runFriendAdd({ configDir: dir, handle: "bob", fingerprint: FP2 }),
    ).rejects.toThrow(/already exists/i);
  });

  it("remove errors on unknown handle", async () => {
    const dir = tmp();
    await runInit({ configDir: dir });
    await expect(
      runFriendRemove({ configDir: dir, handle: "ghost" }),
    ).rejects.toThrow(/not found/i);
  });
});
