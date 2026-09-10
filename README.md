# Obol

A Paseo plugin for running more than one subscription behind the same provider,
switching which one your agents use without restarting the daemon, and seeing
what they are consuming.

Two halves:

- **Subscriptions** — bind a Paseo provider to an account, and swap live agents
  onto it.
- **Usage** — live subscription windows plus per-agent token counts.

## How the swap works

An account is a credential store, and which store a provider process reads is
decided by one environment variable: `CLAUDE_CONFIG_DIR` for Claude, `CODEX_HOME`
for Codex. Paseo already honours both.

Obol registers `server.before("agent.session_open")`, which Paseo calls on
**create, resume, refresh and import**. Paseo does not persist environment
overrides with the agent, so the hook is consulted fresh every time a provider
session opens — the currently bound account is always the one that takes effect.

That makes the swap two steps:

1. Bind the provider to another account (`obol.accounts.select`).
2. Reload the affected agents, which closes and reopens their provider sessions.

Reload is the part the plugin SDK does not expose: `agent.refresh()` in the SDK
is a data refetch, not a session reopen. The reopen lives behind the daemon's
agent-reload RPC, so the handler shells out to `paseo agent reload <id>` — the
supported route for daemon-local work from a server handler. A reload that fails
is reported per agent; the binding itself has already been saved, so the agent
picks it up the next time its session opens either way.

### Scope: fleet, workspace, or one agent

A binding is resolved most-specific-first — the agent's own, then its
workspace's, then the fleet-wide provider default. Because Obol never rewrites a
shared credential store, nothing forces the fleet to move together: three agents
can sit on the work subscription while three others sit on personal, at the same
time.

That also decides what a swap reloads. The plan compares each agent's
**effective** account before and after the change and reloads only the ones that
actually moved, so changing the fleet default leaves a pinned agent alone —
its subscription did not change, and reopening its session would cost a turn and
buy nothing. Measured on a live daemon:

```
create              [obol] bound claude -> claude-alpha via provider (create)
pin agent -> beta   reloaded 1
                    [obol] bound claude -> claude-beta via agent (refresh)
fleet default -> alpha   reloaded 0      # the pinned agent stayed put
```

Pin one agent from its composer:

```
/obol claude-personal
```

A binding that names an account which no longer exists falls through to the next
scope rather than stranding the session unbound.

### A swap never interrupts a turn in flight

Reloading closes and reopens the provider session, and Paseo interrupts a
running turn to do it (`interruptAgentIfRunning` in `session.ts`). On a daemon
with live work that would destroy a turn — including, on your own machine, the
agent that may be driving the swap. So a swap reloads only agents that are not
mid-turn and reports the rest as **deferred**. Deferring costs nothing: the
router is re-consulted on every session open, so a busy agent picks the new
binding up as soon as its session next opens.

### The conversation has to travel with the agent

`CLAUDE_CONFIG_DIR` scopes the credential store **and** the conversation store.
Swapping a live agent therefore moves its credentials and orphans its history:
the reopened session resumes by session id, and that id is a `.jsonl` file under
the account it came from. Measured, before this was handled:

```
[obol] bound claude -> claude-beta (refresh, keys: CLAUDE_CONFIG_DIR)
Claude Code returned an error result:
  No conversation found with session ID: a882dcb9-0767-41f4-965c-a12d678b7224

$ grep -rl a882dcb9 .claude-alpha .claude-beta
.claude-alpha/projects/-private-tmp-obol-demo/a882dcb9-....jsonl
```

So before reloading an agent, Obol mirrors that agent's conversation into the
target account (`server/history.ts`). The copy only ever adds files: the source
account is never modified, and an existing target file is replaced only by a
strictly newer source. The `projects/<dir>` name is computed with the same
encoding Paseo uses (`packages/server/src/server/agent/providers/claude/
project-dir.ts`), so both land on the same directory.

**The order matters.** Copying the conversation into a session that is already
open does nothing — the provider resolves its history when the session opens.
Mirroring after a reload leaves the same error in place; mirroring before it
lets the same agent resume:

```
mirror → reload → send   {"status":"completed"}
reload → mirror → send   {"status":"error","message":"No conversation found..."}
```

### Switching clears the other account's variables

If one account sets two variables and the account replacing it sets one, the
leftover would survive and the session would open against a mix of two
credential stores. Obol computes every key any account for that provider could
set and clears all of them before applying the selected account's. See
`server/routing.test.ts`.

## Accounts

Obol proposes one account per `~/.claude*` and `~/.codex*` directory it finds:
`~/.claude` becomes `claude-default`, `~/.claude-work` becomes `claude-work`.
Discovery only proposes rows. Nothing is bound until you select it.

State lives at `$PASEO_HOME/obol/state.json` and is written atomically:

```json
{
  "accounts": [
    {
      "id": "claude-work",
      "provider": "claude",
      "label": "claude (work)",
      "env": { "CLAUDE_CONFIG_DIR": "/Users/you/.claude-work" }
    }
  ],
  "active": { "claude": "claude-work" },
  "bindings": [
    { "scope": "agent", "key": "<agent-id>", "provider": "claude", "accountId": "claude-personal" }
  ]
}
```

`active` is the fleet default; `bindings` are the narrower overrides. A file
written before scoped bindings existed still loads — `bindings` defaults to `[]`.

`provider` is a Paseo provider id, so it also works with a provider profile
alias from `docs/custom-providers.md`.

## What the numbers mean

Three different quantities get called "usage" and this plugin does not collapse
them.

| Panel section          | What it is                                                              | What it is not                     |
| ---------------------- | ----------------------------------------------------------------------- | ---------------------------------- |
| Subscription windows   | Paseo's own quota fetcher, via `providers.listUsage()`                  | Not a per-account probe            |
| Last-turn consumption  | The token counts each agent reported for its **most recent turn**       | Not a cumulative total, not a bill |

Two limits worth knowing before you read a number off the screen:

- **Windows are not per-account, and for Claude they are not even per-directory.**
  Paseo's fetchers read the daemon's own environment, not the per-agent override
  (`quota-fetcher/providers/codex.ts:87`). For Claude it is worse: the fetcher
  reads `CLAUDE_HOME` — a variable Claude Code does not have — and never
  `CLAUDE_CONFIG_DIR`, then falls back to an *unscoped* Keychain item. Pointed at
  an empty directory it still returns the default account's live usage, measured.
  Claude Code scopes credentials as `Claude Code-credentials-<sha256(dir)[:8]>`;
  the fetcher never reads the scoped item. Reported upstream on
  [getpaseo/paseo#3589](https://github.com/getpaseo/paseo/issues/3589). Until it
  lands, treat the Claude windows as "some account on this machine", not the
  bound one.
- **`lastUsage` is one turn.** Paseo exposes the last turn's tokens per agent,
  not a running total, so the totals row is "the sum of everyone's last turn",
  which is what the heading says.

A cost that no agent reported reads `not reported`, never `$0.00`. An absent
number is unknown, and unknown is not zero.

## Install

```bash
npm install
npm run typecheck
npm test
paseo plugin install /absolute/path/to/obol
paseo plugin ls          # expect: running
```

Plugins must be enabled on the target daemon (`pluginsEnabled: true` in
`$PASEO_HOME/config.json`, then `paseo reload`). Plugin code is trusted and
unsandboxed: the server half runs on the daemon machine with access to its
files, processes and credentials.

## Development

```bash
npm run typecheck
npm test                 # pure logic: routing, ledger aggregation, formatting
paseo plugin reload obol
paseo plugin logs obol
```

The client half must stay mobile-safe — React Native primitives only, colors
from `theme.colors`. This audit must come back empty:

```bash
grep -rnE "document\.|window\.|localStorage|navigator\.|<[a-z]+[ >]|className=|onClick=" client/
```
