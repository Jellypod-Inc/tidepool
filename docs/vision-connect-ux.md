# Connection UX Vision

How connecting two devices should feel — and what needs to change to get there.

## Today (v1)

```
1. Both peers:    claw-connect init              → generates cert + fingerprint
2. Both peers:    figure out your public IP      → doesn't work behind NAT
3. Out of band:   exchange fingerprints + IPs    → copy/paste via Signal, etc.
4. Both peers:    claw-connect friend add ...    → paste fingerprint + endpoint
5. Hope:          pray neither is behind a NAT   → if they are, set up Tailscale/ngrok
```

Five steps, two of which might not work. Identity is a long SHA-256 fingerprint
that must be shared alongside an IP address. NAT breaks everything.

## Target state

```
1. claw-connect init                          → generates DID, publishes to DHT
2. Share your DID with a friend               → one string: did:dht:z6Mkh...
3. claw-connect friend add alice <DID>        → resolves endpoint from DHT
4. Connected.                                 → relay handles NAT automatically
```

Three steps. No IP addresses, no fingerprints, works behind any NAT. The DID
is the only thing you share — it's your identity and your address.

## Stretch goal

```
1. claw-connect init
2. claw-connect friend add alice              → finds Alice via mDNS or DHT
                                              → shows: "Alice (did:dht:z6Mkh...) — accept? y/n"
3. Connected.
```

Two steps. Discovery proposes candidates, you confirm.

## What makes this possible

### DID-based identity (Task 04)

Today identity is a raw X.509 fingerprint (`sha256:a1b2c3...`) that only
works when paired with an IP:port endpoint. Two things to share, both ugly.

With `did:dht`, identity is a single string published to the Mainline DHT.
Your DID encodes your public key. Your endpoint, agent metadata, and service
info are in the DID document stored on the DHT. A friend who has your DID
can resolve everything else automatically.

Key rotation is built in — update the DID document on the DHT, friends
re-resolve and pick up the new key. No manual re-friending.

### Built-in relay (Task 09, Phase 1)

Today, if either peer is behind a NAT, the connection fails. The documented
workaround is "install Tailscale" — which works but adds a dependency.

A built-in relay server solves this without external tools. Both peers
connect outbound to the relay (outbound TCP passes through NATs). The relay
pairs them by peer ID and forwards encrypted bytes. mTLS is end-to-end —
the relay never sees plaintext.

The relay can be self-hosted by anyone, or we run a public one. Peers try
direct connection first and fall back to the relay only when direct fails.

### How they work together

```
Alice runs: claw-connect init
  → Ed25519 keypair generated
  → DID published to Mainline DHT: did:dht:z6MkAlice...
  → DID document contains: public key, endpoint (or relay hint), agent info

Bob runs: claw-connect friend add alice did:dht:z6MkAlice...
  → Bob's daemon resolves the DID from the DHT
  → Gets Alice's public key + endpoint
  → Tries direct mTLS connection to Alice's endpoint
  → If NAT blocks it → connects to relay, Alice connects to same relay
  → mTLS handshake completes (end-to-end, through relay if needed)
  → Bob sends a connection request (existing handshake protocol)
  → Alice accepts → mutual friendship established
  → Both peers' DID documents are cached locally for offline resilience
```

No fingerprints exchanged. No IP addresses shared. No Tailscale installed.

## Task dependency map

```
                    ┌──────────────────────┐
                    │ Task 04              │
                    │ DHT identity +       │
                    │ discovery            │
                    │ (did:dht, Mainline)  │
                    └──────────┬───────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
   ┌──────────────┐  ┌─────────────┐  ┌──────────────────┐
   │ Task 09.1    │  │ Task 02     │  │ Task 01          │
   │ Built-in     │  │ Audit log   │  │ Per-friend       │
   │ relay server │  │ (log trust  │  │ rate limits      │
   │ (NAT)        │  │  decisions) │  │ (protect relay)  │
   └──────────────┘  └─────────────┘  └──────────────────┘
```

Tasks 04 and 09.1 are the critical path. Tasks 01 and 02 are supporting —
the relay needs per-friend rate limits to prevent abuse, and DID-based trust
decisions should be audit-logged.

## Non-goals for this vision

- **No tokens, no blockchain, no incentive economy.** Identity is a keypair.
  Trust is explicit friending. Economics are out of scope.
- **No global agent directory.** The DHT is for identity resolution, not for
  browsing available agents. Discovery finds candidates; trust is deliberate.
- **No cross-peer tool federation.** Agents talk in prose. The transport
  layer moves messages; it does not expose remote tools.
