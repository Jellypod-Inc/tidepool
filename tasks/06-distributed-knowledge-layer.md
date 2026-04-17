# Shared knowledge layer

## Context

Tidepool is purely a transport layer today. Messages flow through and are
retained only as thread history in the adapter's local store. There is no
persistent shared space between peers — no way to publish a note once and
have trusted peers find it later.

Two competitors in the space:

- **Langchain-Chatchat** has a deep single-machine RAG stack (seven vector
  store backends, BM25+KNN retrieval, document loaders)
- **ClawNet** claims a distributed knowledge graph: *"publish once, full-text
  search everywhere"*

Tidepool has neither. Even a simple shared knowledge store between friends
would be a meaningful differentiator — and it fits the prose-only principle:
agents publish and search through adapter tools, and retrieved content flows
back as text. No typed RPC between agents.

## Core concepts

### Groups

A **group** is a named collaboration space (e.g., `eng-team`, `research-pod`).
Groups have:

- A UUID (minted at creation time)
- A membership list managed by a **CRDT OR-Set** — any member can add or
  remove members, changes merge deterministically on reconnect, no leader or
  quorum required
- A shared knowledge store (append-only notes)

Groups live at the daemon level. The daemon manages membership, syncs state
with peers, and routes published notes to group members.

**Availability:** groups work when any subset of members is online. There is
no leader, no quorum, no single point of failure. A member who was offline
for a week catches up by merging state with any other member on reconnect.

### Notes (not "artifacts")

A **note** is any piece of persistent content an agent publishes to a group:
a summary, a decision, a code snippet, a finding, a link — anything worth
keeping. Notes are:

- Append-only (no edits or deletes in Phase 1)
- Signed by the author's identity key
- Searchable by title and body (full-text)
- Scoped to a group

Think of it as "a post in a shared channel that sticks around and is searchable."

## Design

### Group membership — CRDT OR-Set

No external CRDT library needed. A hand-rolled OR-Set is ~100 lines of
TypeScript for a membership list of 3–20 peers.

**Data structure:**

```typescript
type ORSet = {
  adds: Map<string, Set<string>>;    // element → set of unique tags
  tombstones: Set<string>;           // removed tags
};
```

**Operations:**

- `add(member)` — generate a UUID tag, insert into `adds[member]`
- `remove(member)` — move all of `adds[member]`'s tags into `tombstones`
- `merge(local, remote)` — union both `adds` maps, union both `tombstones`
- `members()` — elements with at least one tag not in `tombstones`

**Properties (no coordination needed):**

- Commutative: `merge(A, B) = merge(B, A)`
- Associative: `merge(merge(A, B), C) = merge(A, merge(B, C))`
- Idempotent: `merge(A, A) = A`

Concurrent add + remove of the same member: **add wins** (OR-Set semantics).
This is the safe default — you'd rather have someone unexpectedly present
than unexpectedly kicked.

**Sync protocol (state-based, simplest correct approach):**

1. Two peers connect (or reconnect)
2. Each sends their full OR-Set state (for a 20-member group, this is a few KB)
3. Each calls `merge(local, remote)`
4. Done. Idempotent, order-independent, replay-safe.

No version vectors, no operation logs, no Merkle trees needed at this scale.

### Notes — G-Set (grow-only)

Even simpler than the OR-Set. A G-Set is a set with only `add` and `union`:

```typescript
type NoteStore = Map<string, Note>;  // note ID → note

function merge(local: NoteStore, remote: NoteStore): NoteStore {
  return new Map([...local, ...remote]);  // union by ID
}
```

No conflicts possible — notes are immutable once published, keyed by UUID.

### Note schema

```typescript
type Note = {
  id: string;                    // UUID
  groupId: string;               // group UUID
  authorFingerprint: string;     // who published it
  title: string;
  body: string;
  mimeType?: string;             // default: text/plain
  createdAt: string;             // ISO 8601
  signature: string;             // signed by author's identity key
};
```

### Storage

Local SQLite at `$TIDEPOOL_HOME/knowledge.db`:

```sql
-- Group membership CRDT state (serialized JSON blob per group)
CREATE TABLE group_state (
  group_id    TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  crdt_state  TEXT NOT NULL,        -- JSON: serialized OR-Set
  updated_at  INTEGER NOT NULL
);

-- Individual notes (queryable)
CREATE TABLE notes (
  id                  TEXT PRIMARY KEY,
  group_id            TEXT NOT NULL,
  author_fingerprint  TEXT NOT NULL,
  title               TEXT NOT NULL,
  body                TEXT NOT NULL,
  mime_type            TEXT DEFAULT 'text/plain',
  created_at          TEXT NOT NULL,
  signature           TEXT NOT NULL,
  received_at         INTEGER NOT NULL
);

-- Full-text search over notes
CREATE VIRTUAL TABLE notes_fts USING fts5(title, body, content=notes, content_rowid=rowid);
```

Group CRDT state is stored as a JSON blob (sub-millisecond read/write at
this scale). Notes are stored individually so they're queryable with SQL and
FTS5.

## Protocol

### New A2A methods

- **`group:sync`** — exchange group membership CRDT state. Called on every
  peer reconnect. Each side sends their state; each side merges.
- **`group:invite`** — initial group creation. Creator sends `{groupId, name,
  initialMembership}` to the first members. Receiving peer stores the group
  and begins syncing.
- **`note:publish`** — push a signed note to all currently-reachable group
  members. Recipients store it locally.
- **`note:sync`** — exchange missing notes on reconnect. Simplest approach:
  each side sends a list of note IDs they have; the other side sends back
  any missing notes. (Bloom filter optimization is future work.)

### Sync flow on reconnect

```
Peer A connects to Peer B (both members of group "eng-team"):

1. A → B: group:sync { groupId, crdtState: A's OR-Set }
2. B → A: group:sync { groupId, crdtState: B's OR-Set }
3. Both merge membership locally

4. A → B: note:sync { groupId, haveIds: [id1, id2, ...] }
5. B → A: note:sync { groupId, haveIds: [id3, id4, ...] }
6. B → A: notes A is missing
7. A → B: notes B is missing
```

All operations are idempotent. Re-sending is harmless. Order doesn't matter.

## Adapter tools

Extend the Claude Code adapter:

- **`create_group(name, members)`** — create a new group, invite initial
  members. Returns `{groupId}`.
- **`add_to_group(groupId, member)`** — add a friend to the group.
- **`remove_from_group(groupId, member)`** — remove a member.
- **`list_groups()`** — list groups this agent is a member of.
- **`publish_note(groupId, title, body)`** — publish a note. Returns `{noteId}`.
- **`search_notes(groupId?, author?, query?, since?, limit?)`** — full-text
  search over notes. Returns summaries.
- **`get_note(noteId)`** — get full note body.

The agent remains the sole interface. It decides what to publish, what to
search, and how to use what it finds.

## Phasing

### Phase 1 (this task)

- Hand-rolled OR-Set for group membership (~100 lines)
- G-Set for notes (append-only, no conflicts)
- State-based sync on peer reconnect
- SQLite storage with FTS5 search
- Adapter tools for create/join group, publish/search notes
- Signed notes verified on receipt

### Phase 2 (separate task)

- Threshold approval for member removal (K-of-N co-signatures)
- Note superseding (publish a new version that references the old)
- Tombstone pruning for the OR-Set

### Phase 3 (separate task)

- Vector embeddings over the note corpus
- Semantic search in addition to full-text
- Chunking and retrieval for large notes

## Acceptance criteria (Phase 1)

- `create_group` mints a UUID, stores initial membership, sends invites
- Any member can add or remove other members via adapter tools
- Membership changes propagate via `group:sync` on reconnect
- Two peers who were both offline converge to the same membership after
  reconnecting (CRDT property tests)
- `publish_note` distributes a signed note to all reachable members
- Offline members receive missed notes on reconnect via `note:sync`
- `search_notes` returns FTS5 results from the local store
- Notes with invalid signatures are rejected and logged (audit log, task 02)
- Storage survives daemon restart
- Property tests: OR-Set merge is commutative, associative, idempotent
- Integration test: three peers, one offline during publish, catches up on
  reconnect

## Effort

Large — 3 to 4 weeks.

## Open questions / risks

- **Tombstone growth**: OR-Set tombstones grow forever. For membership lists
  of 3–20 with rare churn, this is negligible. Document the assumption;
  defer pruning to Phase 2.
- **Note storage growth**: no garbage collection in Phase 1. Add a per-group
  size cap with drop-oldest as a safety valve.
- **Membership after removal**: when a member is removed, they keep their
  local copies of prior notes. Removal only affects future sync and
  distribution. Document this.
- **Concurrent add + remove**: OR-Set semantics mean add wins. This is safe
  but may surprise operators. Surface the merge result in the audit log.
- **Sync bandwidth**: full-state exchange works at small scale. If a group
  accumulates thousands of notes, `note:sync` sending all IDs gets expensive.
  Defer Bloom filter optimization to Phase 2.
- **Scope creep**: resist adding vector search, chunking, or embeddings in
  this phase. Those ride on this foundation but belong in Phase 3.

## File pointers

- `packages/tidepool/src/a2a.ts` — extend with group/note methods
- `packages/a2a-claude-code-adapter/src/channel.ts` — add adapter tools
- New: `packages/tidepool/src/knowledge/or-set.ts` — CRDT implementation
- New: `packages/tidepool/src/knowledge/note-store.ts` — SQLite storage
- New: `packages/tidepool/src/knowledge/sync.ts` — reconnect sync logic
