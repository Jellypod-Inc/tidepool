# DHT-based identity and discovery

Replaces the original Task 04 (key rotation) and Task 05 (DHT discovery).
Both share the same infrastructure — a Mainline DHT client in the daemon —
so they belong together.

## Context

ClawConnect has two related gaps:

1. **Identity is a raw fingerprint with no rotation.** If a key leaks, the
   operator must regenerate and manually re-friend everyone. There is no
   standard format, no portable identity, no rotation protocol.

2. **Discovery requires manual config or LAN-only mDNS.** There is no way to
   find a peer on the public internet without exchanging endpoints out of band
   or running a directory server.

Both problems are solved by one piece of infrastructure: a Mainline DHT client
that publishes and resolves signed records.

## Core idea

Use the **Mainline DHT** (the BitTorrent distributed hash table, ~15 million
nodes worldwide) for two purposes:

1. **Identity via `did:dht`** — each peer's identity is a Decentralized
   Identifier published to the DHT. Key rotation updates the DID document in
   the DHT. Friends pin the DID (not a raw fingerprint), so rotation is
   transparent.

2. **Peer discovery** — peers announce themselves on the DHT with a signed
   record containing their endpoint and agent metadata. Other peers look them
   up by DID or handle. Discovery does not confer trust — the mutual friending
   step is unchanged.

One DHT client, two uses.

## How `did:dht` works

A `did:dht` identifier looks like:

```
did:dht:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK
```

The suffix is the public key encoded as a multibase string. The DID document
(a JSON object describing the key, rotation keys, and service endpoints) is
published to the Mainline DHT under `H(did)` as a signed, versioned record.

**Key rotation:** generate a new keypair, update the DID document with the
new public key, sign the update with a designated rotation key, and re-publish
to the DHT. The DID string stays the same (it's derived from the initial key
but the document can point to a new active key). Friends who re-resolve the
DID get the new key automatically.

**Resolution:** given a DID, compute `H(did)`, look it up on the DHT, verify
the signature, extract the current public key and service endpoints.

**TTL:** Mainline DHT records expire after ~24 hours. The daemon re-publishes
every ~12 hours while running. If a peer is offline for days, their DID
becomes unresolvable from the DHT — but friends who previously resolved it
have a cached copy locally, so existing friendships still work.

## Architecture

```
┌─────────────────────────────────────┐
│          claw-connect daemon        │
│                                     │
│  ┌───────────┐   ┌───────────────┐  │
│  │ DHT Client│   │ DID Manager   │  │
│  │ (bittorrent│──▶│ - generate    │  │
│  │  -dht)    │   │ - publish     │  │
│  │           │   │ - resolve     │  │
│  │           │   │ - rotate      │  │
│  └─────┬─────┘   └───────────────┘  │
│        │                            │
│  ┌─────▼──────────────────────────┐ │
│  │ Uses DHT for:                  │ │
│  │  1. Identity (did:dht publish/ │ │
│  │     resolve / rotate)          │ │
│  │  2. Discovery (peer announce / │ │
│  │     lookup by handle or DID)   │ │
│  └────────────────────────────────┘ │
└─────────────────────────────────────┘
        │
        ▼ UDP (Mainline DHT protocol)
   ┌─────────────┐
   │ ~15M nodes  │
   │ BitTorrent  │
   │ Mainline DHT│
   └─────────────┘
```

### Node.js implementation

Use `bittorrent-dht` (npm, ~50KB, MIT, maintained by WebTorrent team) as
the DHT client. It speaks the Mainline DHT protocol over UDP and handles
routing table maintenance, node discovery, and record storage.

On top of it, build a thin `did:dht` layer:

- **Publish:** serialize DID document → sign with identity key → store at
  `H(did)` in DHT via `dht.put()`
- **Resolve:** `dht.get(H(did))` → verify signature → parse DID document →
  extract current public key and service endpoints
- **Rotate:** generate new keypair → update DID document → sign with rotation
  key → `dht.put()` to overwrite

The `bittorrent-dht` package supports BEP 44 (mutable records with Ed25519
signatures), which is exactly the primitive `did:dht` is built on.

## Migration from fingerprints to DIDs

This is a breaking change to the identity model. Migration path:

### Phase 1: dual mode

- `claw-connect init` generates an Ed25519 keypair AND creates a `did:dht`
  identifier. The old X.509 cert is still generated for backward compat.
- `friends.toml` accepts both formats:
  ```toml
  [friends.alice]
  did = "did:dht:z6Mkh..."          # new: DID-based
  # fingerprint = "sha256:..."       # old: still works
  ```
- mTLS handshake: if the friend has a DID, resolve it from DHT (or local
  cache) to get the current public key. Verify the peer cert's key matches.
- Existing fingerprint-based friendships continue to work unchanged.

### Phase 2: DID-only

- Deprecate raw fingerprint config
- All new friendships use DIDs
- `claw-connect friend add` accepts a DID string
- Friending UX: share your DID (a single string) instead of fingerprint +
  endpoint separately

### Phase 3: key rotation

- `claw-connect identity rotate` generates a new keypair, updates the DID
  document, re-publishes to DHT
- Friends re-resolve the DID on next connect and get the new key
- No out-of-band coordination needed
- Audit log records the rotation event

## Discovery via DHT

Separate from identity, but sharing the same DHT client.

- Peer announces a signed record at `H("clawconnect:" + handle)` containing:
  `{did, endpoint, agents: [{name, description}], timestamp}`
- Lookups: `claw-connect discovery find <handle>` or
  `claw-connect discovery find --did <did>`
- Results are candidates only — finding a peer does not friend them. First
  contact goes through the existing connection-request handshake.
- Opt-in via `server.toml`:
  ```toml
  [discovery.dht]
  enabled = true
  announce = true
  ```
- Disabled by default. Enabling announcement makes you findable on the public
  DHT — document the privacy implications.

## Adapter changes

New adapter tools:

- **`whoami()`** — update to return DID in addition to handle
- **`resolve_peer(did_or_handle)`** — resolve a DID or handle via DHT,
  return endpoint + agent metadata. Does not friend them.

Existing tools (`send`, `list_peers`, etc.) continue to use handles. The DID
is the underlying identity; handles remain the user-facing addressing layer.

## Acceptance criteria

### Identity (Phase 1 + 2)
- `claw-connect init` generates Ed25519 keypair and publishes `did:dht`
- `friends.toml` accepts `did = "did:dht:..."` for friend entries
- mTLS handshake resolves DID → current public key and verifies peer cert
- DID document is re-published to DHT every 12 hours while daemon runs
- Resolved DIDs are cached locally with TTL; stale cache falls back to DHT
- Existing fingerprint-based friends continue to work (backward compat)

### Key rotation (Phase 3)
- `claw-connect identity rotate` updates DID document with new key
- Friends re-resolve and accept the new key without manual intervention
- Rotation is logged to audit log (task 02)
- A rotation signed with the wrong key is rejected

### Discovery
- `[discovery.dht]` registers as a discovery provider
- Disabled by default
- Announcements are signed; lookups verify signatures
- `claw-connect discovery find <handle>` returns matching peers
- A discovered peer still requires friending before messages flow
- Integration test: two peers find each other via DHT and complete handshake

## Effort

Large — 4 to 5 weeks total across all phases.

- Phase 1 (dual mode + discovery): ~2 weeks
- Phase 2 (DID-only): ~1 week
- Phase 3 (key rotation): ~1-2 weeks

## Open questions / risks

- **BEP 44 support in `bittorrent-dht`:** verify that the npm package
  supports mutable records with Ed25519 signatures (BEP 44). If not,
  evaluate `@hyperswarm/dht` as an alternative — it also speaks Mainline
  and has BEP 44 support.
- **`did:dht` spec maturity:** the spec is from 2024 and relatively new.
  Check for breaking changes before committing. The DID document format
  itself is W3C-standard; the DHT storage layer is the newer part.
- **DHT record TTL:** ~24 hour expiry means a peer offline for >24h becomes
  unresolvable from the DHT. Mitigation: friends cache the last-resolved
  DID document. A friend who was online when you were still publishing can
  still connect to you using the cached key. The DID just becomes
  non-discoverable by strangers until you come back online.
- **Privacy:** announcing on the public DHT broadcasts your existence and
  endpoint. Discovery should be opt-in, and the privacy tradeoff must be
  documented clearly.
- **UDP firewall:** Mainline DHT uses UDP. Corporate firewalls may block it.
  Fall back to the existing static/mDNS/directory providers when DHT is
  unreachable.
- **Bootstrap nodes:** the DHT client needs initial bootstrap nodes to join
  the network. BitTorrent has well-known bootstrap nodes
  (`router.bittorrent.com`, `dht.transmissionbt.com`). Document that these
  are third-party infrastructure.

## File pointers

- `packages/claw-connect/src/identity.ts` — current X.509 identity generation
  (will be extended/replaced)
- `packages/claw-connect/src/outbound-tls.ts` — fingerprint pinning (will
  add DID resolution path)
- `packages/claw-connect/src/middleware.ts` — friend validation
- `packages/claw-connect/src/discovery/registry.ts` — discovery provider
  interface
- `packages/claw-connect/THREATS.md` — rotation/revocation gap documentation
- New: `packages/claw-connect/src/dht/` — DHT client wrapper, DID manager,
  discovery provider
