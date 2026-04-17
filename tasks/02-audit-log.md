# Audit log

## Context

Today the daemon emits runtime logs (`logs/serve-*.log`) but has no structured,
trust-focused audit trail. If an operator asks "why did my peer auto-accept a
handshake last Tuesday?" or "when was friend X's fingerprint pinned?", there's
no answer. No forensics, no compliance story, no way to detect a quiet
compromise after the fact.

## Proposed approach

Append-only JSONL audit log at `$TIDEPOOL_HOME/audit.log`.

One record per trust-relevant event. Record shape:

```json
{
  "ts": "2026-04-16T12:34:56.789Z",
  "event": "friend.added",
  "actor": "sha256:...",       // fingerprint of the acting peer (local or remote)
  "subject": "alice",          // friend handle, agent name, etc.
  "outcome": "success",
  "reason": "manual",          // manual | auto-accept | llm-decision | ...
  "details": { ... }           // event-specific fields
}
```

Events to log:

- **`handshake.requested`** — inbound connection request received
- **`handshake.decided`** — accept / deny / llm-auto; include mode and reason
- **`friend.added`** / **`friend.removed`** / **`friend.scoped`**
- **`fingerprint.pinned`** / **`fingerprint.changed`** (rare — flag loudly)
- **`config.reloaded`** — with a diff summary, not full config
- **`request.rejected`** — 401/403 with reason (unknown fingerprint, scope
  violation, rate-limited)

Rotation: daily or at 100 MB, whichever first. Retain 30 days by default;
configurable under `[audit]` in `server.toml`.

CLI: `tidepool audit tail [--event <type>] [--friend <handle>]` for quick
queries. A full `audit grep` is out of scope for v1.

## Acceptance criteria

- Every event type above writes a JSONL record
- Records include timestamp, event type, fingerprint(s) involved, outcome, reason
- **Message bodies are never logged** — only metadata (sender, thread, size)
- Log rotates on size and date
- `tidepool audit tail` prints the last N records (default 50)
- A failed write never blocks or crashes the daemon (best-effort fsync)

## Effort

Small — ~1 day.

## Open questions / risks

- **PII in `reason` fields**: LLM auto-accept reasoning can contain prompt
  injection leftovers. Consider hashing or truncating long reason strings.
- **Disk full**: the audit log must fail open (keep serving requests) and emit
  a runtime error when it can't write. Do not tie availability to the audit log.
- **Tamper evidence**: v1 is append-only file; no signing or hash chain.
  Acceptable for small teams. A later task could add hash-chained records.

## File pointers

- `packages/tidepool/src/handshake.ts` — handshake decision points
- `packages/tidepool/src/middleware.ts` — request-reject points
- `packages/tidepool/src/config.ts` — reload points (if present)
