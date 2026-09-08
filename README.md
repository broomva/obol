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
  "active": { "claude": "claude-work" }
}
```

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

- **Windows belong to the daemon's credential context, not to each account.**
  Paseo's fetchers read `process.env.CODEX_HOME` and friends
  (`packages/server/src/services/quota-fetcher/providers/codex.ts:87`), which is
  the daemon's environment, not the per-agent override. So the windows shown are
  the ones for whichever account is currently bound. Obol labels them that way
  rather than implying it probed every account.
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
