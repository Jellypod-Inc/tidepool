import { randomUUID } from "node:crypto";
import type { PeersConfig } from "./types.js";
import type { ThreadIndex } from "./thread-index.js";
import {
  handleToAgentDid,
  resolveHandle,
} from "./peers/resolve.js";
import type {
  BroadcastRequest,
  BroadcastResponse,
  BroadcastResultItem,
} from "./schemas.js";
import { MULTI_PARTY_ENVELOPE_V1_URL } from "./extensions.js";

export interface DeliveryOutcome {
  delivery: "accepted" | "failed";
  reason?: {
    kind: "daemon-down" | "peer-not-registered" | "peer-unreachable" | "other";
    message: string;
    hint?: string;
  };
}

export interface BroadcastDeps {
  peers: () => PeersConfig;
  localAgents: () => string[];
  threadIndex: ThreadIndex;
  deliverRemote: (
    peerName: string,
    agentName: string,
    body: unknown,
  ) => Promise<DeliveryOutcome>;
  deliverLocal: (agentName: string, senderAgent: string, body: unknown) => Promise<DeliveryOutcome>;
}

export interface BroadcastInput extends BroadcastRequest {
  senderAgent: string;
}

export class BroadcastValidationError extends Error {
  constructor(
    public code: "invalid_addressed_to" | "invalid_in_reply_to" | "unknown_peer",
    public detail: Record<string, unknown>,
  ) {
    super(code);
  }
}

export class BroadcastHandler {
  constructor(private deps: BroadcastDeps) {}

  async run(input: BroadcastInput): Promise<BroadcastResponse> {
    const peersConfig = this.deps.peers();
    const localAgents = this.deps.localAgents();
    const contextId = input.thread ?? randomUUID();
    const messageId = randomUUID();

    // Resolve each display handle → canonical AgentDid (sender-view)
    const recipients = input.peers.map((handle) => {
      try {
        return {
          displayHandle: handle,
          did: handleToAgentDid(handle, peersConfig, localAgents),
          resolved: resolveHandle(handle, peersConfig, localAgents),
        };
      } catch (e) {
        throw new BroadcastValidationError("unknown_peer", {
          handle,
          error: (e as Error).message,
        });
      }
    });

    // Validate addressed_to ⊆ peers (by DID)
    let addressedDids: string[] | undefined;
    if (input.addressed_to) {
      addressedDids = input.addressed_to.map((h) => {
        try {
          return handleToAgentDid(h, peersConfig, localAgents);
        } catch (e) {
          throw new BroadcastValidationError("invalid_addressed_to", {
            handle: h,
            error: (e as Error).message,
          });
        }
      });
      const recipientDidSet = new Set(recipients.map((r) => r.did));
      for (const d of addressedDids) {
        if (!recipientDidSet.has(d)) {
          throw new BroadcastValidationError("invalid_addressed_to", { did: d });
        }
      }
    }

    // Validate in_reply_to if provided (fail-open on unknown context)
    if (input.in_reply_to) {
      const presence = this.deps.threadIndex.has(contextId, input.in_reply_to);
      if (presence === "absent") {
        throw new BroadcastValidationError("invalid_in_reply_to", {
          message_id: input.in_reply_to,
          context_id: contextId,
        });
      }
      // "present" or "unknown" → accept
    }

    // Record sender's outbound message in thread-index (for future in_reply_to by others)
    this.deps.threadIndex.record(contextId, messageId);

    // Build canonical participants list: sender + all recipients (as DIDs)
    // TODO: sender identity should travel as this peer's real DID once
    // a "self" peer entry exists. For now "self::" is a local-only marker;
    // receiver-side re-projection (inbound stamping) will stamp the correct
    // sender handle in the recipient's view.
    const senderDid: string = `self::${input.senderAgent}`;
    const participantDids = [senderDid, ...recipients.map((r) => r.did)];

    // Fan out
    const results = await Promise.all(
      recipients.map(
        (r): Promise<BroadcastResultItem> =>
          this.deliverOne({
            displayHandle: r.displayHandle,
            resolved: r.resolved,
            contextId,
            messageId,
            text: input.text,
            participantDids,
            addressedTo: addressedDids,
            inReplyTo: input.in_reply_to,
            senderAgent: input.senderAgent,
          }),
      ),
    );

    return { context_id: contextId, message_id: messageId, results };
  }

  private async deliverOne(ctx: {
    displayHandle: string;
    resolved: ReturnType<typeof resolveHandle>;
    contextId: string;
    messageId: string;
    text: string;
    participantDids: string[];
    addressedTo?: string[];
    inReplyTo?: string;
    senderAgent: string;
  }): Promise<BroadcastResultItem> {
    const body = {
      message: {
        messageId: ctx.messageId,
        contextId: ctx.contextId,
        role: "user",
        parts: [{ kind: "text", text: ctx.text }],
        metadata: {
          participants: ctx.participantDids,
          ...(ctx.addressedTo ? { addressed_to: ctx.addressedTo } : {}),
          ...(ctx.inReplyTo ? { in_reply_to: ctx.inReplyTo } : {}),
        },
        extensions: [MULTI_PARTY_ENVELOPE_V1_URL],
      },
    };

    const outcome =
      ctx.resolved.kind === "local"
        ? await this.deps.deliverLocal(ctx.resolved.agent, ctx.senderAgent, body)
        : await this.deps.deliverRemote(
            ctx.resolved.peer,
            ctx.resolved.agent,
            body,
          );

    return outcome.delivery === "accepted"
      ? { peer: ctx.displayHandle, delivery: "accepted" }
      : { peer: ctx.displayHandle, delivery: "failed", reason: outcome.reason };
  }
}
