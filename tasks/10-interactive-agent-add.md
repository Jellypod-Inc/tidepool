# Interactive agent add

## Context

The primary `agent add` verb (see the `agent-first CLI` redesign) is scriptable:
you pass the endpoint + agent name, the daemon TOFUs the fingerprint, and it's
written. That's the right default for automation and for users who already know
which agent of a peer they want.

But in the common "I was just given Bob's URL and I want to see what he has"
case, typing the agent name you haven't seen yet is a dead end. The right UX
there is an interactive browse-and-select flow — closer to how `vercel link` or
`gh repo fork` feel than to traditional `add` CLI verbs.

## Proposed approach

Add an interactive sibling verb — `tidepool add` — that takes only an endpoint
and walks the user through agent selection.

```
$ tidepool add https://bob.example:9900
→ fetching peer card from https://bob.example:9900...
→ observed cert fingerprint: sha256:d4e5f6...
  trust this peer? [y/n] y

  Bob has the following agents:
    [x] rust-expert    — Rust code review
    [ ] writer         — Drafts long-form prose
    [x] trader         — Market research
    [ ] (cancel)

→ press <space> to toggle, <enter> to confirm

→ added: rust-expert, trader (as bobs-trader, aliased to avoid collision with local)
```

Implementation notes:

- Reuses the same peer-fetch + fingerprint TOFU code path as `agent add`
- Checkbox UI via a small TTY helper (no new heavy deps — ANSI + raw input is
  enough for checkboxes and a confirmation line)
- Collision detection runs per-selected-agent; prompts inline for an alias when
  needed rather than aborting
- Non-TTY stdin → exits with a helpful error pointing at `tidepool agent add`
  for scripting

This is additive. It doesn't replace `tidepool agent add`; it's the
human-facing affordance on top.

## Why defer

The agent-first redesign ships the scriptable path first because it's what
every automation, test, and doc example needs. The interactive flow is a
polish layer — valuable for first-time users, not load-bearing for the
protocol. Splitting them keeps the initial cut small.

## Open questions

- Does the interactive flow belong under `tidepool add` (terse) or
  `tidepool agent browse` (more discoverable)?
- Should `tidepool agent add` auto-upgrade to interactive mode when the user
  passes only an endpoint (no agent name)? Probably yes — one verb, two modes.
- Should we also offer a non-interactive variant that just lists, so scripts
  can pipe (`tidepool agent list --peer https://bob:9900 --json`)?
