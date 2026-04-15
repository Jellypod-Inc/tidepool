import { describe, it, expect } from "vitest";
import net from "net";
import { pickFreeLoopbackPort } from "../../src/cli/free-port.js";

describe("pickFreeLoopbackPort", () => {
  it("returns a port in the ephemeral range", async () => {
    const port = await pickFreeLoopbackPort();
    expect(port).toBeGreaterThanOrEqual(1024);
    expect(port).toBeLessThan(65536);
  });

  it("returns a port that can actually be bound", async () => {
    const port = await pickFreeLoopbackPort();
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve());
      });
    });
  });
});
