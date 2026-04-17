import { describe, it, expect } from "vitest";
import { mergeAgentCard } from "../src/session/card-merge.js";

describe("mergeAgentCard", () => {
  it("combines daemon-owned transport fields with adapter-supplied fragment", () => {
    const card = mergeAgentCard(
      { name: "alice", publicUrl: "https://t.example", tenant: "alice" },
      {
        description: "Personal assistant",
        skills: [{ id: "chat", name: "chat" }],
        capabilities: { streaming: false, extensions: [] },
        defaultInputModes: ["text/plain"],
        defaultOutputModes: ["text/plain"],
      },
    );

    expect(card.name).toBe("alice");
    expect(card.description).toBe("Personal assistant");
    expect(card.url).toBe("https://t.example/alice");
    expect(card.skills).toEqual([{ id: "chat", name: "chat" }]);
    expect(card.capabilities).toEqual({
      streaming: false,
      pushNotifications: false,
      extensions: [],
    });
    expect(card.defaultInputModes).toEqual(["text/plain"]);
    expect(card.defaultOutputModes).toEqual(["text/plain"]);
    expect(card.securitySchemes).toEqual({});
    expect(card.securityRequirements).toEqual([]);
  });

  it("fills defaults when fragment omits optional fields", () => {
    const card = mergeAgentCard(
      { name: "bob", publicUrl: "https://t.example", tenant: "bob" },
      {},
    );
    expect(card.description).toBe("");
    expect(card.skills).toEqual([]);
    expect(card.capabilities).toEqual({
      streaming: false,
      pushNotifications: false,
      extensions: [],
    });
    expect(card.defaultInputModes).toEqual(["text/plain"]);
    expect(card.defaultOutputModes).toEqual(["text/plain"]);
  });

  it("uses provider from transport when supplied", () => {
    const card = mergeAgentCard(
      {
        name: "alice",
        publicUrl: "https://t.example",
        tenant: "alice",
        provider: { organization: "tidepool", url: "https://tidepool.dev" },
      },
      {},
    );
    expect(card.provider).toEqual({
      organization: "tidepool",
      url: "https://tidepool.dev",
    });
  });

  it("never lets fragment override transport-owned fields (name, url)", () => {
    const card = mergeAgentCard(
      { name: "alice", publicUrl: "https://t.example", tenant: "alice" },
      { description: "x" } as any,
    );
    expect(card.name).toBe("alice");
    expect(card.url).toBe("https://t.example/alice");
  });
});
