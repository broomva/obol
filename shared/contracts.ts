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
  /** Launch environment overrides that select this account's credential store. */
  env: z.record(z.string(), z.string()),
});
export type Account = z.infer<typeof AccountSchema>;

export const RouterStateSchema = z.object({
  accounts: z.array(AccountSchema),
  /** provider id -> account id currently bound to it. */
  active: z.record(z.string(), z.string()),
});
export type RouterState = z.infer<typeof RouterStateSchema>;

export const listAccounts = defineRpc({
  name: "obol.accounts.list",
  input: z.object({}),
  output: z.object({
    accounts: z.array(AccountSchema),
    active: z.record(z.string(), z.string()),
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
    reloadAgents: z.boolean().default(false),
  }),
  output: z.object({
    provider: z.string(),
    accountId: z.string(),
    reloadedAgentIds: z.array(z.string()),
    /** Mid-turn agents left alone; they pick the binding up on their next open. */
    deferredAgentIds: z.array(z.string()),
    reloadErrors: z.array(z.object({ agentId: z.string(), error: z.string() })),
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
