# Per-friend rate limits

## Context

The daemon today has two rate-limiting scopes:

- **Global** token bucket (server-wide protection)
- **Per-agent** token bucket (configured under `[agents.<name>] rateLimit`)

There is no per-friend bucket. If a single friend misbehaves — compromised key, a
runaway agent loop, a buggy adapter retrying aggressively — they drain the global
bucket and degrade service for every other friend. `THREATS.md` (Threat 4) flags
this: rate limiting is not a security boundary, but it should still be a
blast-radius boundary.

## Proposed approach

Add a third scope: per-friend. Bucket key = friend fingerprint.

1. Extend the rate limiter to accept a composite key `(friendFingerprint, agentName)`
   and walk three buckets in order: global → friend → agent. Any bucket exhausted
   → 429.
2. Add `rateLimit` to `friends.toml`:

   ```toml
   [friends.alice]
   fingerprint = "sha256:..."
   rateLimit = "100/hour"   # optional; inherits a default if absent
   ```

3. Add a default `[server.defaults] friendRateLimit = "..."` in `server.toml`
   so operators can set a baseline without per-friend config.
4. Include friend handle + remaining tokens in 429 responses so operators can
   diagnose which friend is hot.

## Acceptance criteria

- `friends.toml` accepts `rateLimit = "N/interval"` per friend
- A friend who exceeds their bucket gets 429; other friends are unaffected
- Global and per-agent buckets still function as before
- Hot-reload of `friends.toml` updates live buckets without daemon restart
- Unit tests cover: friend over-limit isolates, per-agent still enforced,
  global still enforced, config reload updates buckets

## Effort

Small — ~0.5 day.

## Open questions / risks

- **Reload semantics**: when a friend's rate limit changes on reload, do we
  reset the bucket or just the refill rate? Lean toward preserving current
  tokens, adjusting refill rate only.
- **Unknown-friend requests**: CONNECTION_REQUEST handshakes arrive before
  friendship exists. They should be rate-limited by source IP or by a
  `connectionRequests` bucket, not per-friend. Keep this out of scope for
  this task.

## File pointers

- `packages/tidepool/src/middleware.ts` — current rate-limit middleware
- `packages/tidepool/src/types.ts` — `FriendConfig`, `AgentConfig` types
- `packages/tidepool/THREATS.md` — Threat 4
