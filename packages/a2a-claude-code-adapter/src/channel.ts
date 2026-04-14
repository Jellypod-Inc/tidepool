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

const INSTRUCTIONS =
  "Authenticated A2A messages arrive as <channel source=\"a2a\" task_id=\"...\"> events. " +
  "The task_id attribute uniquely identifies each incoming message. " +
  "To reply, call the a2a_reply tool with the exact task_id from the tag and your response text. " +
  "The reply is delivered back to the sending peer through the claw-connect network.";

export function createChannel(opts: CreateChannelOpts) {
  const serverName = opts.serverName ?? "a2a";
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
        name: "a2a_reply",
        description:
          "Send a reply to an inbound A2A message. Call this when you see a <channel source=\"a2a\" task_id=\"...\"> event.",
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
    ],
  }));

  const handleToolCall = async (
    req: ToolCallRequest,
  ): Promise<ToolCallResult> => {
    if (req.name !== "a2a_reply") {
      throw new Error(`unknown tool: ${req.name}`);
    }
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

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return handleToolCall({
      name: req.params.name,
      arguments: (req.params.arguments ?? {}) as Record<string, unknown>,
    });
  });

  const notifyInbound = async (info: InboundInfo): Promise<void> => {
    await server.notification({
      method: "notifications/claude/channel",
      params: {
        content: info.text,
        meta: { task_id: info.taskId },
      },
    });
  };

  return { server, notifyInbound, handleToolCall };
}
