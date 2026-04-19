# Task 12: Outbound-dispatch helper extraction

**Status:** Code-quality follow-up identified during multi-party envelope v1 implementation (Task 6 review).

## Problem

Three daemon-outbound code paths duplicate the mTLS dispatcher + fetch + error-mapping block (~20–25 lines each):

1. `src/server.ts` — `POST /:peer/:agent/:action` handler (scoped outbound route)
2. `src/server.ts` — `POST /:tenant/:action` handler (bare-handle outbound route)
3. `src/server.ts` — `deliverToRemotePeer` closure used by `POST /message:broadcast`

The broadcast path (#3) was added during multi-party envelope v1. It deliberately did not refactor paths #1 and #2 because they also handle `message:stream` (SSE proxy via `proxyUpstreamOrFail`, `buildFailedStatusEvent`), which returns a different result shape than `DeliveryOutcome`.

## Proposed extraction

Introduce `src/outbound-dispatch.ts` (or similar) with two helpers:

```typescript
// Non-streaming: returns DeliveryOutcome (never throws)
export async function dispatchNonStreaming(opts: {
  endpoint: string;
  agent: string;
  action: string;
  fingerprint: string;
  certPath: string;
  keyPath: string;
  body: unknown;
  senderAgent?: string; // stamped as X-Sender-Agent if provided
}): Promise<DeliveryOutcome>;

// Streaming: returns the raw fetch Response + helpers for proxying into the downstream
export async function dispatchStreaming(opts: {
  /* same inputs as above */
}): Promise<{ response: Response; /* helpers */ }>;
```

Both legacy routes (#1, #2) would choose `dispatchStreaming` for `message:stream` action and `dispatchNonStreaming` otherwise. The broadcast path (#3) always uses `dispatchNonStreaming`. Delete the duplicated `buildPinnedDispatcher` + `fetch` + error-mapping blocks in `server.ts`.

## Why this matters

- ~45 lines of effectively identical code across three sites is a maintenance drag — fixes and logging need to be applied three times.
- Any future outbound call site (e.g., a fourth outbound route) increases the multiplier.
- The current shape hides real differences (e.g., `X-Sender-Agent` is stamped in the legacy routes but not in `deliverToRemotePeer`) under mostly-similar code, making intentional vs accidental divergence hard to read.

## Non-goals

- Changing the wire protocol or response shapes of the legacy routes
- Moving streaming out of the `server.ts` route handlers
- Unifying the two legacy routes (`/:peer/:agent/:action` and `/:tenant/:action`) — they have genuinely different handle-resolution paths

## When to do this

Before adding a fourth outbound call site. If someone proposes a new outbound endpoint and the first instinct is "copy the mTLS block from `deliverToRemotePeer`", stop and do this refactor first.

## Dependencies

- Multi-party envelope v1 shipped (the `feat/multi-party-envelope` branch). No other coupling.
