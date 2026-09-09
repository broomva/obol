import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RpcInput } from "@getpaseo/plugin";
import type { listAccounts, selectAccount, usageSnapshot } from "../shared/contracts";
import { mirrorClaudeHistory } from "./history";
import {
  type AgentLike,
  activeAgents,
  agentsFromEntries,
  rollupByProvider,
  toLastTurnEntry,
  totalsOf,
} from "./ledger";
import { planAgentReloads } from "./reload-plan";
import { findActiveAccount } from "./routing";
import { loadStateWithDiscovery, saveState, statePath } from "./state";

const run = promisify(execFile);

/** Anything with the Paseo SDK surface this plugin touches. */
interface PaseoLike {
  agents: { list(options?: Record<string, unknown>): Promise<{ entries: unknown[] }> };
  // provider.usage.list.response payload: { requestId, fetchedAt, providers }
  providers: { listUsage(): Promise<{ fetchedAt?: string; providers: unknown[] }> };
}

export async function handleListAccounts(_input: RpcInput<typeof listAccounts>) {
  const state = await loadStateWithDiscovery();
  return { accounts: state.accounts, active: state.active, statePath: statePath() };
}

/**
 * The plugin SDK's `agent.refresh()` is a data refetch, not a session reopen —
 * the reopen lives behind the daemon's agent-reload RPC, which the bundled CLI
 * exposes as `paseo agent reload`. Shelling out is the supported path for
 * daemon-local work from a server handler; a failure is reported per agent
 * rather than failing the whole swap, because the binding itself already stuck.
 */
async function reloadAgent(agentId: string): Promise<string | null> {
  try {
    await run("paseo", ["agent", "reload", agentId, "--json"], { timeout: 60_000 });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function handleSelectAccount(
  { provider, accountId, reloadAgents }: RpcInput<typeof selectAccount>,
  context: { paseo: PaseoLike },
) {
  const state = await loadStateWithDiscovery();
  const account = state.accounts.find(
    (candidate) => candidate.id === accountId && candidate.provider === provider,
  );
  if (!account) {
    throw new Error(`No account '${accountId}' is configured for provider '${provider}'`);
  }

  await saveState({ accounts: state.accounts, active: { ...state.active, [provider]: accountId } });

  const reloadedAgentIds: string[] = [];
  const deferredAgentIds: string[] = [];
  const reloadErrors: { agentId: string; error: string }[] = [];

  if (reloadAgents) {
    const result = await context.paseo.agents.list({});
    const entries = agentsFromEntries(result.entries);
    const plan = planAgentReloads(entries, provider);
    deferredAgentIds.push(...plan.defer);
    const byId = new Map(entries.map((agent) => [agent.id, agent]));
    const affected = plan.reload.map((id) => byId.get(id)).filter((a): a is AgentLike => !!a);
    // The account we are leaving, resolved before the save above took effect.
    const previous = state.active[provider];
    const previousAccount = state.accounts.find(
      (candidate) => candidate.id === previous && candidate.provider === provider,
    );

    for (const agent of affected) {
      // Carry the conversation across first: the reopened session resumes by
      // session id, and that id is a file inside the account's config dir.
      const from = previousAccount?.env.CLAUDE_CONFIG_DIR;
      const to = account.env.CLAUDE_CONFIG_DIR;
      if (from && to && agent.cwd) {
        try {
          await mirrorClaudeHistory({ fromConfigDir: from, toConfigDir: to, cwd: agent.cwd });
        } catch (error) {
          reloadErrors.push({
            agentId: agent.id,
            error: `history mirror failed: ${error instanceof Error ? error.message : String(error)}`,
          });
          continue;
        }
      }
      const error = await reloadAgent(agent.id);
      if (error) reloadErrors.push({ agentId: agent.id, error });
      else reloadedAgentIds.push(agent.id);
    }
  }

  return { provider, accountId, reloadedAgentIds, deferredAgentIds, reloadErrors };
}

interface RawQuota {
  providerId?: unknown;
  displayName?: unknown;
  status?: unknown;
  planLabel?: unknown;
  error?: unknown;
  windows?: unknown;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeQuota(raw: RawQuota, boundAccountId: string | null) {
  const windows = Array.isArray(raw.windows) ? raw.windows : [];
  return {
    providerId: text(raw.providerId, "unknown"),
    displayName: text(raw.displayName, text(raw.providerId, "unknown")),
    status: text(raw.status, "unknown"),
    planLabel: nullableText(raw.planLabel),
    boundAccountId,
    windows: windows.map((entry) => {
      const window = entry as Record<string, unknown>;
      return {
        id: text(window.id, "window"),
        label: text(window.label, text(window.id, "window")),
        usedPct: nullableNumber(window.usedPct),
        resetsAt: nullableText(window.resetsAt),
        tone: nullableText(window.tone),
      };
    }),
    error: nullableText(raw.error),
  };
}

export async function handleUsageSnapshot(
  _input: RpcInput<typeof usageSnapshot>,
  context: { paseo: PaseoLike },
) {
  const state = await loadStateWithDiscovery();

  let quotas: ReturnType<typeof normalizeQuota>[] = [];
  let quotaError: string | null = null;
  try {
    const usage = await context.paseo.providers.listUsage();
    const rows = usage.providers as RawQuota[];
    quotas = rows.map((row) => {
      const providerId = text(row.providerId, "unknown");
      const bound = findActiveAccount(state, providerId);
      return normalizeQuota(row, bound?.id ?? null);
    });
  } catch (error) {
    quotaError = error instanceof Error ? error.message : String(error);
  }

  const result = await context.paseo.agents.list({});
  const lastTurns = activeAgents(agentsFromEntries(result.entries)).map(toLastTurnEntry);

  return {
    capturedAt: new Date().toISOString(),
    quotas,
    quotaError,
    lastTurns,
    byProvider: rollupByProvider(lastTurns),
    totals: totalsOf(lastTurns),
  };
}
