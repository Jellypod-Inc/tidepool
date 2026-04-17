import { EventEmitter } from "events";

export type TapDirection = "inbound" | "outbound";

export interface TapEvent {
  ts: number;
  direction: TapDirection;
  from: string;
  to: string;
  action: string;
  contextId?: string;
  messageId?: string;
  text?: string;
}

const PREVIEW_MAX = 400;

function extractPreview(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const parts = (message as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return undefined;
  for (const part of parts) {
    if (part && typeof part === "object" && (part as { kind?: unknown }).kind === "text") {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") {
        return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}…` : text;
      }
    }
  }
  return undefined;
}

export interface EmitOpts {
  direction: TapDirection;
  from: string;
  to: string;
  action: string;
  message: unknown;
}

export class MessageTap {
  private emitter = new EventEmitter();
  private buffer: TapEvent[] = [];

  constructor(private capacity = 50) {
    this.emitter.setMaxListeners(0);
  }

  emit(opts: EmitOpts): void {
    const msg = opts.message as { contextId?: unknown; messageId?: unknown } | undefined;
    const event: TapEvent = {
      ts: Date.now(),
      direction: opts.direction,
      from: opts.from,
      to: opts.to,
      action: opts.action,
      contextId: typeof msg?.contextId === "string" ? msg.contextId : undefined,
      messageId: typeof msg?.messageId === "string" ? msg.messageId : undefined,
      text: extractPreview(opts.message),
    };

    this.buffer.push(event);
    if (this.buffer.length > this.capacity) this.buffer.shift();
    this.emitter.emit("event", event);
  }

  recent(): TapEvent[] {
    return [...this.buffer];
  }

  subscribe(listener: (event: TapEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }
}
