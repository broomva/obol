import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * An account is one subscription behind one Paseo provider. Switching accounts
 * means switching which credential store the provider process reads, so the
 * whole binding is expressed as launch environment: `CLAUDE_CONFIG_DIR` for
 * Claude, `CODEX_HOME` for Codex. Paseo reads both already
 * (packages/server/src/server/agent/providers/claude/project-dir.ts:70,
 * codex-app-server-agent.ts:554).
 */
export const AccountSchema = z.object({
  id: z.string().min(1),
  /** Paseo provider id this account binds to, e.g. "claude" or a profile alias. */
  provider: z.string().min(1),
  label: z.string().min(1),
  /**
   * Launch environment overrides that select this account's credential store.
   * Empty for the default account: with no config-dir variable set the provider
   * falls back to its own default store, and re-asserting that path would pick a
   * *different* store instead of changing nothing (BRO-2518).
   */
  env: z.record(z.string(), z.string()),
  /**
   * Where this account's config dir actually lives. Distinct from `env`: the
   * default account has a config dir on disk (`~/.claude`) but must contribute
   * no launch override. Conversation history is stored under this path, so code
   * that moves history needs the *path*, while code that opens a session needs
   * the *env*. Conflating the two is what made the default account inject a
   * variable it had no business setting. Optional for back-compat with state
   * persisted before this field existed.
   */
  configDir: z.string().optional(),
});
export type Account = z.infer<typeof AccountSchema>;

/**
 * A binding narrower than the provider default. Orca's switch is one global
 * choice because it rewrites one shared credential store; Obol points each
 * process at a different store, so nothing forces the whole fleet to move
 * together. That makes a fleet of agents on several subscriptions at once
 * expressible, which is the case a single global switch cannot represent.
 */
export const ScopedBindingSchema = z.object({
  scope: z.enum(["workspace", "agent"]),
  /** The workspace id or agent id this binding applies to. */
  key: z.string().min(1),
  provider: z.string().min(1),
  accountId: z.string().min(1),
});
export type ScopedBinding = z.infer<typeof ScopedBindingSchema>;

export const RouterStateSchema = z.object({
  accounts: z.array(AccountSchema),
  /** provider id -> account id; the default when nothing narrower matches. */
  active: z.record(z.string(), z.string()),
  /** Overrides, most specific first at resolution: agent, then workspace. */
  bindings: z.array(ScopedBindingSchema).default([]),
});
export type RouterState = z.infer<typeof RouterStateSchema>;

/** Where a binding applies. `provider` is the fleet-wide default. */
export const BindingScopeSchema = z.enum(["provider", "workspace", "agent"]);
export type BindingScope = z.infer<typeof BindingScopeSchema>;

export const listAccounts = defineRpc({
  name: "obol.accounts.list",
  input: z.object({}),
  output: z.object({
    accounts: z.array(AccountSchema),
    active: z.record(z.string(), z.string()),
    bindings: z.array(ScopedBindingSchema),
    statePath: z.string(),
  }),
});

/**
 * Bind a provider to an account. `reloadAgents` reopens matching live sessions
 * so they pick the new binding up; without it the swap applies only to sessions
 * opened later. Env overrides are not persisted with agent config, so the
 * router is re-consulted on every session open and stays the source of truth.
 */
export const selectAccount = defineRpc({
  name: "obol.accounts.select",
  input: z.object({
    provider: z.string().min(1),
    accountId: z.string().min(1),
    /** Defaults to the fleet-wide provider default. */
    scope: BindingScopeSchema.default("provider"),
    /** Required for `workspace` and `agent`: the id the binding applies to. */
    key: z.string().min(1).optional(),
    reloadAgents: z.boolean().default(false),
  }),
  output: z.object({
    provider: z.string(),
    accountId: z.string(),
    scope: BindingScopeSchema,
    key: z.string().nullable(),
    reloadedAgentIds: z.array(z.string()),
    /** Mid-turn agents left alone; they pick the binding up on their next open. */
    deferredAgentIds: z.array(z.string()),
    reloadErrors: z.array(z.object({ agentId: z.string(), error: z.string() })),
    /** One actionable explanation for the whole swap, not one per agent. */
    reloadHint: z.string().nullable(),
  }),
});

export const QuotaWindowSchema = z.object({
  id: z.string(),
  label: z.string(),
  usedPct: z.number().nullable(),
  resetsAt: z.string().nullable(),
  tone: z.string().nullable(),
});

/**
 * Live subscription windows, straight from Paseo's own quota fetcher via
 * `providers.listUsage()`.
 *
 * These describe the credential context the DAEMON runs in, not each account
 * separately: the fetchers read `process.env.CODEX_HOME` and friends
 * (packages/server/src/services/quota-fetcher/providers/codex.ts:87). So these
 * windows belong to whichever account is currently bound, and the plugin says
 * so rather than implying it has probed every account.
 */
export const ProviderQuotaSchema = z.object({
  providerId: z.string(),
  displayName: z.string(),
  status: z.string(),
  planLabel: z.string().nullable(),
  boundAccountId: z.string().nullable(),
  windows: z.array(QuotaWindowSchema),
  error: z.string().nullable(),
});

/**
 * Per-agent token counts. Paseo exposes `lastUsage`, which is the LAST TURN
 * only, not a cumulative total. Trace usage, an API-equivalent estimate, and a
 * metered charge are three different numbers; this plugin reports the first and
 * never relabels it as the others.
 */
export const LastTurnEntrySchema = z.object({
  agentId: z.string(),
  label: z.string(),
  provider: z.string(),
  status: z.string(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number().nullable(),
  contextUsedPct: z.number().nullable(),
});

export const ProviderRollupSchema = z.object({
  provider: z.string(),
  agents: z.number(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number().nullable(),
});

export const usageSnapshot = defineRpc({
  name: "obol.usage.snapshot",
  input: z.object({}),
  output: z.object({
    capturedAt: z.string(),
    /** Live subscription windows for the currently bound accounts. */
    quotas: z.array(ProviderQuotaSchema),
    quotaError: z.string().nullable(),
    /** Last-turn token counts per agent. Not cumulative. */
    lastTurns: z.array(LastTurnEntrySchema),
    byProvider: z.array(ProviderRollupSchema),
    totals: z.object({
      agents: z.number(),
      inputTokens: z.number(),
      cachedInputTokens: z.number(),
      outputTokens: z.number(),
      costUsd: z.number().nullable(),
    }),
  }),
});
