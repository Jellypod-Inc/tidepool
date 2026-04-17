# NAT traversal and WireGuard transport

## Context

Tidepool peers listen on `:9900` for inbound mTLS connections. This works
when peers have direct IP reachability — same LAN, or both on public IPs.
But most real peers are behind NATs or firewalls: home routers, corporate
networks, cloud VPCs. A remote peer cannot connect to your daemon if your
laptop is behind a NAT.

This is the single biggest deployment friction. THREATS.md documents the gap
and recommends "use Tailscale or ngrok" as a workaround, but there is no
first-class solution.

This task evaluates all options, from zero-code-changes to full transport
replacement, and recommends which to build.

## Option 1: Tailscale (zero code changes)

Both peers install Tailscale and join the same Tailnet. Tailscale assigns
each machine a stable IP (e.g., `100.64.0.1`) reachable from any other
machine on the Tailnet via a WireGuard tunnel.

```bash
# Alice's machine — daemon listens on :9900 as usual
# Tailscale assigns Alice 100.64.0.1

# Bob (on the same Tailnet) connects to 100.64.0.1:9900
# NAT traversal handled by Tailscale (STUN hole-punch + DERP relay fallback)
```

Tidepool doesn't need to know Tailscale exists. mTLS runs on top of the
WireGuard tunnel (double encryption — harmless).

**Pros:**
- Works today. Zero code changes.
- Tailscale handles NAT traversal, key management, and relay.
- 94%+ direct connection rate (Tailscale's published number).
- Free tier supports up to 100 devices.

**Cons:**
- Both peers must have Tailscale installed and join the same Tailnet.
- Onboarding friction: "install this other product first" is a hurdle.
- Dependency on Tailscale's infrastructure and account system.
- Tailnet membership is a trust boundary Tidepool doesn't control.

**Effort:** Zero code. Documentation only.

## Option 2: Tailscale Funnel (expose to public internet)

Tailscale Funnel exposes a local port to the public internet via a
Tailscale-assigned hostname. No Tailnet membership required on the
connecting side.

```bash
tailscale funnel 9900
# Your daemon is now reachable at https://alice-machine.tailnet-name.ts.net:9900
# Anyone on the internet can connect — no Tailscale needed on their end
```

**Pros:**
- One-command setup on the serving side.
- No Tailscale requirement on the connecting side.
- Tailscale handles TLS termination and NAT traversal.

**Cons:**
- Tailscale terminates TLS at their edge. mTLS client certificate auth may
  not pass through — needs testing. If it doesn't, Tidepool loses its
  primary authentication mechanism.
- Your endpoint is a Tailscale-controlled hostname.
- Funnel has bandwidth limits on the free tier.
- Dependency on Tailscale staying free / available.

**Effort:** Zero code. Testing + documentation.

## Option 3: VPS + WireGuard reverse proxy (self-hosted)

Rent a VPS ($5/mo) with a public IP. Set up a WireGuard tunnel from your
laptop to the VPS. Run a TCP reverse proxy (nginx, caddy, socat) on the VPS
that forwards `:9900` through the tunnel to your laptop.

```
Friend ──TCP──▶ VPS:9900 ──WireGuard tunnel──▶ Your laptop:9900
                (public IP)                     (behind NAT)
```

mTLS passes through cleanly — the proxy just forwards TCP bytes.

**Pros:**
- No dependency on Tailscale or any third-party service.
- Full control over the infrastructure.
- mTLS works unchanged (TCP proxy is transparent).
- One VPS can serve multiple peers.

**Cons:**
- Requires a VPS and WireGuard/nginx setup — significant ops overhead.
- The VPS is a single point of failure and a recurring cost.
- Every user who wants to be reachable needs their own VPS (or shares one).
- Not a product — it's a sysadmin recipe.

**Effort:** Zero code. Documentation (setup guide).

## Option 4: Built-in relay server (lightweight, first-class)

Build a simple relay server that Tidepool peers can route through when
direct connection fails. The relay is a thin TCP or WebSocket proxy — it
forwards encrypted mTLS bytes without terminating TLS or seeing plaintext.

```
Alice (behind NAT)                        Bob (behind NAT)
     │                                         │
     └───mTLS──▶ Relay server ◀──mTLS──────────┘
                (public IP)
                (just forwards bytes)
```

Both peers connect outbound to the relay (outbound TCP works through NATs).
The relay pairs them by peer ID and forwards bytes bidirectionally.

**Pros:**
- First-class Tidepool feature — no external tools required.
- mTLS is end-to-end; the relay sees only ciphertext.
- Simple to implement (~200-300 lines for a TCP relay).
- Could be self-hosted by anyone, or we run a public one.
- **Business model seed:** free relay with rate limits, paid tier for
  guaranteed bandwidth / uptime / SLA.

**Cons:**
- Requires someone to host the relay (us, the community, or the user).
- All traffic for NATted peers goes through the relay — latency and
  bandwidth cost.
- Relay is a single point of failure for NATted peers.
- No hole-punching — always relays, even when direct would have worked.

**Effort:** Medium — ~1 week for the relay server + client integration.

## Option 5: Built-in STUN + relay (hole-punch first, relay fallback)

Extend Option 4 with STUN-based UDP hole punching. Peers try to connect
directly first; if hole-punching fails (symmetric NAT), fall back to the
relay.

```
1. Alice asks STUN server: "what's my public IP:port?"
2. Bob asks STUN server: "what's my public IP:port?"
3. Both exchange public endpoints via the relay (signaling only)
4. Both send UDP packets to each other's public endpoint simultaneously
5. NAT sees outbound packet → allows inbound from that IP → hole punched
6. Direct WireGuard tunnel established
7. HTTP traffic flows through the tunnel — no relay needed

If hole-punch fails → fall back to relay (Option 4)
```

**Pros:**
- Direct connection ~94% of the time (avoids relay latency/cost).
- Relay is only for the ~6% of symmetric NATs that can't hole-punch.
- Matches what Tailscale does internally.

**Cons:**
- Significantly more complex than a simple relay.
- Requires UDP (corporate firewalls may block it).
- STUN + signaling + hole-punch + fallback is a lot of state machine.
- Still need a relay for fallback.

**Effort:** Large — 2-3 weeks on top of the relay.

## Option 6: WireGuard as transport (replace mTLS entirely)

The most ambitious option. Replace mTLS with WireGuard tunnels as the
transport layer. Each peer's WireGuard key is derived from their Ed25519
identity key (same key used for `did:dht` in Task 04).

```
┌─────────────────────────────────┐
│       tidepool daemon       │
│                                 │
│  WireGuard Manager              │
│   - one tunnel per active peer  │
│   - Ed25519 → Curve25519 key   │
│   - STUN hole-punch            │
│   - relay fallback             │
│                                 │
│  HTTP server (plain, no TLS)    │
│   - runs inside WireGuard      │
│   - same routes as today       │
│   - auth by WireGuard peer key │
└─────────────────────────────────┘
```

**Identity unification:** Ed25519 keypair generated at `tidepool init`
serves as:
- `did:dht` identity (signing)
- DHT record signing key
- WireGuard tunnel key (converted to Curve25519 via
  `crypto_sign_ed25519_pk_to_curve25519`)

One key for everything. No X.509 certs, no fingerprint pinning, no cert
generation.

**What we delete:**
- X.509 certificate generation (`src/identity.ts` cert parts)
- HTTPS / mTLS server on `:9900` (`src/server.ts`)
- Fingerprint pinning (`src/outbound-tls.ts`)
- TLS-related middleware

**What we gain:**
- Unified identity (one keypair for DID + DHT + transport)
- NAT traversal (STUN + relay built into the transport layer)
- Simpler mental model (WireGuard peer key = identity)
- Better performance (WireGuard is faster than TLS)

**Pros:**
- Cleanest architecture long-term.
- Solves identity, encryption, and NAT traversal in one layer.
- No X.509 complexity.
- Ed25519 → Curve25519 conversion is well-supported (`libsodium`,
  `@noble/curves`).

**Cons:**
- Largest implementation effort by far.
- Userspace WireGuard in Node.js is uncharted — need to validate that
  `boringtun` (Rust, via napi-rs) or `wireguard-go` (as subprocess) works
  without root and without a tun device.
- Breaking change — old mTLS peers can't talk to new WireGuard peers without
  a migration period.
- Browsers can't do WireGuard (UDP) — if browser agents are ever on the
  roadmap, need a WebSocket transport anyway.
- Multiple simultaneous tunnels (one per active friend) — memory and CPU
  implications at scale.

**Effort:** Research spike ~1 week. Build (if validated) ~4-6 weeks.

## Research questions (apply to Options 5 and 6)

### Userspace WireGuard in Node.js
- Can `boringtun` (Rust) be wrapped with `napi-rs` for Node bindings? Do
  bindings already exist?
- Can `wireguard-go` run as a subprocess without a tun device?
- Any pure JS/TS/WASM WireGuard implementation?
- Can we get a tunnel running inside the Node process without root?

### Ed25519 → Curve25519 key conversion
- Is `@noble/curves` or `libsodium-wrappers` sufficient?
- Security concerns with using the same key for signing and key exchange?
  (Generally considered safe for Ed25519/X25519 but verify.)

### STUN infrastructure
- Can we use public STUN servers (Google, Cloudflare) or do we need our own?
- What's the UX for peers behind symmetric NATs that can't hole-punch?

### Relay hosting
- Cost for a minimal relay server (just forwards encrypted bytes)?
- Could this be the seed of a business model (free tier + paid SLA)?

## Recommendation

The options aren't mutually exclusive. A phased approach:

**Now (zero effort):**
- Document Option 1 (Tailscale) and Option 3 (VPS + WireGuard) as
  recommended setups for remote peers. This unblocks users today.

**Next (medium effort, high value):**
- Build Option 4 (built-in relay server). Simple, first-class, and opens a
  business model. ~1 week.

**Later (large effort, cleanest architecture):**
- Research spike for Option 6 (WireGuard as transport). ~1 week to validate.
  If the PoC works, build it over ~4-6 weeks alongside Task 04 (DHT identity)
  since they share the Ed25519 keypair.
- Option 5 (STUN hole-punching) is a natural extension of either Option 4
  or Option 6.

## Acceptance criteria (phased)

### Phase 0: Documentation
- README or docs page covers Options 1, 2, and 3 with step-by-step setup
- Tailscale Funnel tested: confirm whether mTLS client certs pass through

### Phase 1: Built-in relay server
- New package `packages/tidepool-relay/` or new command
  `tidepool relay serve`
- Relay forwards TCP/WebSocket bytes without terminating TLS
- Peers connect to relay with their peer ID; relay pairs and forwards
- Config in `server.toml`:
  ```toml
  [relay]
  url = "wss://relay.example.com"   # relay to use when direct fails
  ```
- Daemon tries direct connection first; falls back to relay on failure
- Relay logs connections but never sees plaintext (mTLS is end-to-end)
- Integration test: two peers behind simulated NATs connect via relay

### Phase 2: WireGuard research spike
- PoC: two Node processes, userspace WireGuard tunnel, HTTP request through
  tunnel, no root required
- Written report answering all research questions above
- Go / no-go recommendation

### Phase 3: WireGuard transport (if Phase 2 validates)
- WireGuard transport as alternative to mTLS (`[transport] mode = "wireguard"`)
- Ed25519 → Curve25519 key derivation from DID keypair
- STUN hole-punching with relay fallback
- Migration guide from mTLS to WireGuard

## Effort

- Phase 0: ~1 day (documentation)
- Phase 1: ~1 week (relay server)
- Phase 2: ~1 week (research spike)
- Phase 3: ~4-6 weeks (if validated)

## Open questions / risks

- **Userspace WireGuard maturity in Node:** may be the blocker for Option 6.
  If no good integration exists, Option 4 (relay) is the pragmatic ceiling
  and still delivers real value.
- **Relay as SPOF:** a relay failure knocks out all NATted peers. Mitigate
  with multiple relays and client-side failover.
- **Browser agents:** WireGuard is UDP-only. If browser-based agents are
  ever on the roadmap, the relay needs a WebSocket mode anyway. Design the
  relay with WebSocket from the start to keep that door open.
- **Complexity budget:** Option 6 is a major architectural change. The
  current mTLS stack works. Don't replace it unless the identity unification
  and NAT traversal benefits clearly justify the migration.

## File pointers

- `packages/tidepool/src/identity.ts` — current keypair/cert generation
- `packages/tidepool/src/server.ts` — current mTLS server
- `packages/tidepool/src/outbound-tls.ts` — current fingerprint pinning
- `packages/tidepool/src/middleware.ts` — current friend auth
- `packages/tidepool/THREATS.md` — NAT traversal gap
- Task 04 (`04-dht-identity-and-discovery.md`) — shares Ed25519 keypair story
