import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { InboundInfo } from "./http.js";
import type { ThreadStore } from "./thread-store.js";
import type { SendError } from "./outbound.js";

export type CreateChannelOpts = {
  self: string;
  store: ThreadStore;
  listPeers: () => string[];
  send: (
    peer: string,
    text: string,
    thread?: string,
  ) => Promise<{ contextId: string; messageId: string }>;
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
  peer: z.string().min(1),
  text: z.string().min(1),
  thread: z.string().optional(),
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
  "This MCP server connects you to peer agents over the claw-connect network. " +
  "Inbound messages arrive as <channel source=\"claw-connect\" peer=\"...\" " +
  "context_id=\"...\" task_id=\"...\" message_id=\"...\"> events. To respond, " +
  "call `send` with thread=<context_id> from the tag — there is no separate " +
  "reply tool. To start a new conversation, call `send` without thread. Use " +
  "`list_peers` before sending; never guess handles. Use `list_threads` when " +
  "interleaving multiple peers, and `thread_history` to re-load context after " +
  "a gap.";

function isSendError(err: unknown): err is SendError {
  return (
    typeof err === "object" &&
    err !== null &&
    "kind" in err &&
    "message" in err &&
    "hint" in err
  );
}

export function createChannel(opts: CreateChannelOpts) {
  const serverName = opts.serverName ?? "claw-connect";
  const server = new Server(
    { name: serverName, version: "0.0.1" },
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
        description:
          "Send a message to a peer. Use `thread` to continue an existing conversation (pass the `context_id` from a prior <channel> event). Omit `thread` to start a new conversation. Replies arrive later as a separate <channel source=\"claw-connect\"> event with the same context_id. Always call `list_peers` before guessing a handle.",
        inputSchema: {
          type: "object",
          properties: {
            peer: { type: "string", description: "peer handle from list_peers" },
            text: { type: "string", description: "message text" },
            thread: {
              type: "string",
              description:
                "context_id to continue a thread; omit to start a new one",
            },
          },
          required: ["peer", "text"],
        },
      },
      {
        name: "whoami",
        description: "Return this agent's own handle on the claw-connect network.",
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
          "List threads this agent is part of. A thread is a chain of messages with one peer, identified by context_id. Use to triage when multiple peers are active. Optionally filter by peer.",
        inputSchema: {
          type: "object",
          properties: {
            peer: { type: "string", description: "filter to one peer" },
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
    try {
      const { contextId, messageId } = await opts.send(
        parsed.data.peer,
        parsed.data.text,
        parsed.data.thread,
      );
      opts.store.record({
        contextId,
        peer: parsed.data.peer,
        messageId,
        from: opts.self,
        text: parsed.data.text,
        sentAt: Date.now(),
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              context_id: contextId,
              message_id: messageId,
            }),
          },
        ],
      };
    } catch (err) {
      if (isSendError(err)) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `[claw-connect] send to "${parsed.data.peer}" failed: ${err.message}\n\nHow to recover: ${err.hint}`,
            },
          ],
        };
      }
      throw err;
    }
  };

  const handleWhoami = (): ToolCallResult => ({
    content: [{ type: "text", text: JSON.stringify({ handle: opts.self }) }],
  });

  const handleListPeers = (): ToolCallResult => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          peers: opts.listPeers().map((handle) => ({ handle })),
        }),
      },
    ],
  });

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
              peer: s.peer,
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
    opts.store.record({
      contextId: info.contextId,
      peer: info.peer,
      messageId: info.messageId,
      from: info.peer,
      text: info.text,
      sentAt: Date.now(),
    });
    await server.notification({
      method: "notifications/claude/channel",
      params: {
        content: info.text,
        meta: {
          peer: info.peer,
          context_id: info.contextId,
          task_id: info.taskId,
          message_id: info.messageId,
        },
      },
    });
  };

  return { server, notifyInbound, handleToolCall };
}
