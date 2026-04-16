import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { PendingRegistry } from "./pending.js";
import type { InboundInfo } from "./http.js";

export type CreateChannelOpts = {
  registry: PendingRegistry;
  serverName?: string;
  self: string;
  listPeers: () => string[];
  send: (peer: string, text: string) => Promise<{ taskId: string }>;
};

export type ToolCallRequest = {
  name: string;
  arguments: Record<string, unknown>;
};

export type ToolCallResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const ReplyArgsSchema = z.object({
  task_id: z.string().min(1),
  text: z.string(),
});

const SendArgsSchema = z.object({
  peer: z.string().min(1),
  text: z.string().min(1),
});

const INSTRUCTIONS =
  "This MCP server exposes the claw-connect agent-to-agent network. " +
  "Inbound messages arrive as <channel source=\"claw-connect\" task_id=\"...\"> events; " +
  "reply with the claw_connect_reply tool using the exact task_id from the tag. " +
  "To initiate a conversation, call claw_connect_list_peers to see who you can reach, " +
  "then claw_connect_send to open a new thread — the peer's reply will arrive later as " +
  "another <channel source=\"claw-connect\"> event with the task_id returned by send. " +
  "Use claw_connect_whoami to check your own handle. " +
  "Never guess peer handles; always list first.";

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
        name: "claw_connect_reply",
        description:
          "Reply to an inbound claw-connect message. Call this when you see a <channel source=\"claw-connect\" task_id=\"...\"> event.",
        inputSchema: {
          type: "object",
          properties: {
            task_id: {
              type: "string",
              description: "task_id attribute from the inbound <channel> tag",
            },
            text: {
              type: "string",
              description: "reply text to send back to the peer",
            },
          },
          required: ["task_id", "text"],
        },
      },
      {
        name: "claw_connect_whoami",
        description:
          "Return this agent's own handle on the claw-connect network.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: "claw_connect_list_peers",
        description:
          "List the handles of peers this agent can reach on the claw-connect network. Call this before claw_connect_send — do not guess handles.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: "claw_connect_send",
        description:
          "Initiate a new conversation with a peer. Returns a task_id immediately; the peer's reply arrives later as a <channel source=\"claw-connect\" task_id=\"...\"> event.",
        inputSchema: {
          type: "object",
          properties: {
            peer: {
              type: "string",
              description:
                "peer handle (from claw_connect_list_peers); do not guess",
            },
            text: {
              type: "string",
              description: "message text to send",
            },
          },
          required: ["peer", "text"],
        },
      },
    ],
  }));

  const handleReply = (req: ToolCallRequest): ToolCallResult => {
    const parsed = ReplyArgsSchema.safeParse(req.arguments);
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
    const ok = opts.registry.resolve(parsed.data.task_id, parsed.data.text);
    if (!ok) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `unknown task_id: ${parsed.data.task_id} (it may have already been replied to or timed out)`,
          },
        ],
      };
    }
    return {
      content: [{ type: "text", text: `sent (task_id=${parsed.data.task_id})` }],
    };
  };

  const handleWhoami = (): ToolCallResult => ({
    content: [{ type: "text", text: JSON.stringify({ handle: opts.self }) }],
  });

  const handleListPeers = (): ToolCallResult => {
    const peers = opts.listPeers().map((handle) => ({ handle }));
    return {
      content: [{ type: "text", text: JSON.stringify({ peers }) }],
    };
  };

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
    const { taskId } = await opts.send(parsed.data.peer, parsed.data.text);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            task_id: taskId,
            note: "reply will arrive as a <channel source=\"claw-connect\" task_id=\"...\"> event",
          }),
        },
      ],
    };
  };

  const handleToolCall = async (
    req: ToolCallRequest,
  ): Promise<ToolCallResult> => {
    switch (req.name) {
      case "claw_connect_reply":
        return handleReply(req);
      case "claw_connect_whoami":
        return handleWhoami();
      case "claw_connect_list_peers":
        return handleListPeers();
      case "claw_connect_send":
        return handleSend(req);
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
    const meta: Record<string, string> = { task_id: info.taskId };
    if (info.messageId) meta.message_id = info.messageId;
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
