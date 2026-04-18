import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { InboundInfo } from "./http.js";
import type { ThreadStore } from "./thread-store.js";
import type { BroadcastResponse } from "./outbound.js";
import { BroadcastError } from "./outbound.js";
import { ADAPTER_VERSION } from "./version.js";

export type CreateChannelOpts = {
  self: string;
  store: ThreadStore;
  listPeers: () => Promise<string[]>;
  broadcast: (args: {
    peers: string[];
    text: string;
    thread?: string;
    addressed_to?: string[];
    in_reply_to?: string;
  }) => Promise<BroadcastResponse>;
  serverName?: string;
};

export type ToolCallRequest = {
  name: string;
  arguments: Record<string, unknown>;
};

export type ToolCallResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

const SendArgsSchema = z.object({
  peers: z.array(z.string().min(1)).min(1),
  text: z.string().min(1),
  thread: z.string().optional(),
  addressed_to: z.array(z.string().min(1)).optional(),
  in_reply_to: z.string().min(1).optional(),
});

const ListThreadsArgsSchema = z.object({
  peer: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

const ThreadHistoryArgsSchema = z.object({
  thread: z.string().min(1),
  limit: z.number().int().positive().optional(),
});

const INSTRUCTIONS =
  "This MCP server connects you to peer agents over the tidepool network. " +
  "Inbound messages arrive as <channel source=\"tidepool\" peer=\"...\" " +
  "participants=\"...\" context_id=\"...\" task_id=\"...\" message_id=\"...\"> " +
  "events. `peer` is the sender of that particular message; `participants` is " +
  "the full list of agents (including you) in the thread as the sender sees " +
  "it — present only on multi-party messages (2+ agents in the thread); " +
  "absent on pairwise. To reply to one peer, call `send` with `peers: [\"<peer>\"]` and " +
  "`thread=<context_id>`. To reply-all in a multi-party thread, pass every " +
  "other participant: `peers: <all participants except your own handle>`. " +
  "To start a new conversation, call `send` without `thread`; a fresh " +
  "context_id is minted. Multi-peer sends share one context_id and carry the " +
  "participant list to every recipient — there is no room, no join/leave, " +
  "no enforcement: it is a convention agents negotiate. Use `list_peers` " +
  "before sending; never guess handles. Use `list_threads` when interleaving " +
  "multiple peers, and `thread_history` to re-load context after a gap.";

export function createChannel(opts: CreateChannelOpts) {
  const serverName = opts.serverName ?? "tidepool";
  const server = new Server(
    { name: serverName, version: ADAPTER_VERSION },
    {
      capabilities: {
        experimental: { "claude/channel": {} },
        tools: {},
      },
      instructions: INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "send",
        description: [
          "Send a message to one or more tidepool peers. Returns the shared message_id plus per-peer delivery outcomes.",
          "",
          "peers: handles (bare or peer/agent scoped).",
          "text: prose content.",
          "thread: optional context_id to continue an existing thread.",
          "addressed_to: optional subset of peers to hint who the message is directed at (broadcast recipients see this).",
          "in_reply_to: optional message_id being replied to (must be visible in the same thread).",
        ].join("\n"),
        inputSchema: {
          type: "object",
          properties: {
            peers: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              description:
                "one or more peer handles from list_peers. Length 1 for pairwise; length 2+ for multi-party.",
            },
            text: { type: "string", description: "message text" },
            thread: {
              type: "string",
              description:
                "context_id to continue a thread; omit to start a new one",
            },
            addressed_to: {
              type: "array",
              items: { type: "string" },
              description:
                "optional subset of peers to hint who the message is directed at",
            },
            in_reply_to: {
              type: "string",
              description:
                "optional message_id being replied to (must be visible in the same thread)",
            },
          },
          required: ["peers", "text"],
        },
      },
      {
        name: "whoami",
        description: "Return this agent's own handle on the tidepool network.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "list_peers",
        description:
          "List handles of peers this agent can reach. Call before send; do not guess.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "list_threads",
        description:
          "List threads this agent is part of. A thread is identified by context_id and may have one or more peer participants. Use to triage when multiple peers are active. Optionally filter by peer (matches threads where that peer is any participant).",
        inputSchema: {
          type: "object",
          properties: {
            peer: { type: "string", description: "filter to threads that include this peer" },
            limit: { type: "number", description: "return at most N threads" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "thread_history",
        description:
          "Re-load messages from a thread you've been away from. Returns messages chronologically with sender and timestamp.",
        inputSchema: {
          type: "object",
          properties: {
            thread: { type: "string", description: "context_id of the thread" },
            limit: {
              type: "number",
              description: "return at most N most-recent messages",
            },
          },
          required: ["thread"],
          additionalProperties: false,
        },
      },
    ],
  }));

  const handleSend = async (req: ToolCallRequest): Promise<ToolCallResult> => {
    const parsed = SendArgsSchema.safeParse(req.arguments);
    if (!parsed.success) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `invalid arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          },
        ],
      };
    }
    const { peers, text, thread, addressed_to, in_reply_to } = parsed.data;
    // Dedupe peers in input order so fanout doesn't double-send.
    const uniquePeers = Array.from(new Set(peers));

    let resp: BroadcastResponse;
    try {
      resp = await opts.broadcast({
        peers: uniquePeers,
        text,
        thread,
        addressed_to,
        in_reply_to,
      });
    } catch (err) {
      if (err instanceof BroadcastError) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: {
                  status: err.status,
                  detail: err.detail,
                  message: err.message,
                },
              }),
            },
          ],
        };
      }
      throw err;
    }

    // Record the shared outbound message in thread-store keyed by shared message_id.
    // Participants are daemon-stamped — we only track which peers we sent to.
    const acceptedPeers = resp.results
      .filter((r) => r.delivery === "accepted")
      .map((r) => r.peer);
    if (acceptedPeers.length > 0) {
      opts.store.record({
        contextId: resp.context_id,
        peers: acceptedPeers,
        messageId: resp.message_id,
        from: opts.self,
        text,
        sentAt: Date.now(),
      });
    }

    const allFailed = resp.results.every((r) => r.delivery === "failed");
    return {
      isError: allFailed,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            context_id: resp.context_id,
            message_id: resp.message_id,
            results: resp.results,
          }),
        },
      ],
    };
  };

  const handleWhoami = (): ToolCallResult => ({
    content: [{ type: "text", text: JSON.stringify({ handle: opts.self }) }],
  });

  const handleListPeers = async (): Promise<ToolCallResult> => {
    const peers = await opts.listPeers();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            peers: [...peers].sort().map((handle) => ({ handle })),
          }),
        },
      ],
    };
  };

  const handleListThreads = (req: ToolCallRequest): ToolCallResult => {
    const parsed = ListThreadsArgsSchema.safeParse(req.arguments);
    if (!parsed.success) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `invalid arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          },
        ],
      };
    }
    const summaries = opts.store.listThreads({
      peer: parsed.data.peer,
      limit: parsed.data.limit,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            threads: summaries.map((s) => ({
              context_id: s.contextId,
              peers: s.peers,
              last_message_at: s.lastMessageAt,
              message_count: s.messageCount,
            })),
          }),
        },
      ],
    };
  };

  const handleThreadHistory = (req: ToolCallRequest): ToolCallResult => {
    const parsed = ThreadHistoryArgsSchema.safeParse(req.arguments);
    if (!parsed.success) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `invalid arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          },
        ],
      };
    }
    const messages = opts.store.history(parsed.data.thread, {
      limit: parsed.data.limit,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            messages: messages.map((m) => ({
              message_id: m.messageId,
              from: m.from,
              text: m.text,
              sent_at: m.sentAt,
            })),
          }),
        },
      ],
    };
  };

  const handleToolCall = async (
    req: ToolCallRequest,
  ): Promise<ToolCallResult> => {
    switch (req.name) {
      case "send":
        return handleSend(req);
      case "whoami":
        return handleWhoami();
      case "list_peers":
        return handleListPeers();
      case "list_threads":
        return handleListThreads(req);
      case "thread_history":
        return handleThreadHistory(req);
      default:
        throw new Error(`unknown tool: ${req.name}`);
    }
  };

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return handleToolCall({
      name: req.params.name,
      arguments: (req.params.arguments ?? {}) as Record<string, unknown>,
    });
  });

  const notifyInbound = async (info: InboundInfo): Promise<void> => {
    // Non-self participants (the thread's other members, from the sender's view).
    const otherPeers = info.participants.filter((p) => p !== opts.self);
    opts.store.record({
      contextId: info.contextId,
      // Fallback: if filtering self leaves zero peers (malformed inbound where
      // the sender omitted themselves), fall back to the actual sender so the
      // thread isn't peerless and list_threads still finds it.
      peers: otherPeers.length > 0 ? otherPeers : [info.peer],
      messageId: info.messageId,
      from: info.peer,
      text: info.text,
      sentAt: Date.now(),
    });

    // meta.peer is always the sender of *this* message. meta.participants,
    // when present, is the full thread membership from the sender's view.
    const meta: Record<string, unknown> = {
      peer: info.peer,
      context_id: info.contextId,
      task_id: info.taskId,
      message_id: info.messageId,
    };
    // Surface participants on the channel block only when multi-party.
    if (info.participants.length > 1) {
      // Space-separated string — renders cleanly as a <channel …> attribute and
      // is trivial to split on the agent side.
      meta.participants = info.participants.join(" ");
    }

    await server.notification({
      method: "notifications/claude/channel",
      params: {
        content: info.text,
        meta,
      },
    });
  };

  return { server, notifyInbound, handleToolCall };
}
