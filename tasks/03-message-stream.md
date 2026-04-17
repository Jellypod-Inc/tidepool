# Streaming (`message:stream`)

## Context

The adapter today implements `message:send` only — a request-response cycle where
the sender POSTs one message and gets an ack, and the reply (if any) arrives
later as a separate channel event. The A2A v1.0 spec defines `message:stream` for
incremental token-by-token responses, but the adapter README already flags
this as v1 future work.

Without streaming, multi-agent conversation feels like email rather than chat.
Long replies block. ClawNet almost certainly supports streaming, and Langchain-
Chatchat has streaming for its own chat surface; staying send-only makes
Tidepool feel more primitive than it is.

## Proposed approach

Implement `POST /<agent>/message:stream` with Server-Sent Events on both the
daemon and the adapter. A2A's `StreamEvent` types are already defined in
`packages/tidepool/src/a2a.ts`.

**Daemon side:**

- New route `POST /<agent>/message:stream` (both mTLS and loopback ports)
- Proxy SSE in both directions: inbound stream from a friend → local adapter;
  outbound stream from local adapter → friend
- Apply rate limits per-event (not per-stream) so streamers can't bypass limits
  by holding one long connection

**Adapter side:**

- Emit incremental channel events as tokens arrive
- The inbound SSE handler buffers tokens into a single channel event boundary
  per semantic chunk (sentence or punctuation break) to avoid flooding the
  agent with one-token events
- `send` tool gains an optional `stream: true` flag — when set, the tool
  returns after the first token arrives and subsequent tokens flow as
  additional channel events

## Acceptance criteria

- `message:stream` works end-to-end between two peers over mTLS
- Streams survive transient network hiccups via SSE reconnect with
  `Last-Event-ID`
- Rate limits apply per event, not per stream
- An agent on the receiving side sees incremental channel events with a shared
  `context_id` and `message_id`
- Backpressure: if the receiver isn't draining, the sender eventually errors
  rather than buffering unbounded
- Existing `message:send` continues to work unchanged

## Effort

Medium — 3 to 5 days.

## Open questions / risks

- **mTLS + SSE + HTTP/2**: Node's HTTPS + SSE usually works on HTTP/1.1; verify
  no HTTP/2 corner cases with the current mTLS stack
- **Backpressure model**: SSE has no native backpressure. Decide on a max
  in-flight event count per stream and disconnect on overrun
- **Channel event shape**: Claude Code channels may need a `partial: true`
  marker to distinguish streaming chunks from complete messages. Check the
  experimental channel spec before finalizing the event format
- **Thread replay**: `thread_history` should reconstitute streamed messages as
  their final assembled text, not as partial chunks

## File pointers

- `packages/tidepool/src/a2a.ts` — existing `StreamEvent` types
- `packages/a2a-claude-code-adapter/README.md` — current v1 limitation note
- `packages/a2a-claude-code-adapter/src/channel.ts` — channel event emission
- `packages/tidepool/src/server.ts` — HTTPS/HTTP server setup
