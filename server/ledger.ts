import type { z } from "zod";
import type { LastTurnEntrySchema, ProviderRollupSchema } from "../shared/contracts";

export type LastTurnEntry = z.infer<typeof LastTurnEntrySchema>;
export type ProviderRollup = z.infer<typeof ProviderRollupSchema>;

/** The subset of a Paseo agent snapshot the ledger reads. */
export interface AgentLike {
  id: string;
  provider: string;
  status: string;
  title?: string | null;
  archivedAt?: string | null;
  lastUsage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    totalCostUsd?: number;
    contextWindowMaxTokens?: number;
    contextWindowUsedTokens?: number;
  };
}

function percent(used: number | undefined, max: number | undefined): number | null {
  if (used === undefined || max === undefined || max <= 0) return null;
  return Math.round((used / max) * 1000) / 10;
}

export function toLastTurnEntry(agent: AgentLike): LastTurnEntry {
  const usage = agent.lastUsage ?? {};
  return {
    agentId: agent.id,
    label: agent.title?.trim() ? agent.title.trim() : agent.id.slice(0, 8),
    provider: agent.provider,
    status: agent.status,
    inputTokens: usage.inputTokens ?? 0,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    costUsd: usage.totalCostUsd ?? null,
    contextUsedPct: percent(usage.contextWindowUsedTokens, usage.contextWindowMaxTokens),
  };
}

/**
 * Cost is summed only across the agents that actually reported one. An absent
 * cost is unknown, not zero, so a rollup with no reporting agent stays `null`
 * instead of claiming $0.00 was spent.
 */
function sumCost(entries: LastTurnEntry[]): number | null {
  const reported = entries.filter((entry) => entry.costUsd !== null);
  if (reported.length === 0) return null;
  return reported.reduce((total, entry) => total + (entry.costUsd ?? 0), 0);
}

export function rollupByProvider(entries: LastTurnEntry[]): ProviderRollup[] {
  const groups = new Map<string, LastTurnEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.provider);
    if (group) group.push(entry);
    else groups.set(entry.provider, [entry]);
  }

  return Array.from(groups.entries())
    .map(([provider, group]) => ({
      provider,
      agents: group.length,
      inputTokens: group.reduce((total, entry) => total + entry.inputTokens, 0),
      cachedInputTokens: group.reduce((total, entry) => total + entry.cachedInputTokens, 0),
      outputTokens: group.reduce((total, entry) => total + entry.outputTokens, 0),
      costUsd: sumCost(group),
    }))
    .sort((left, right) => right.outputTokens - left.outputTokens || left.provider.localeCompare(right.provider));
}

export function totalsOf(entries: LastTurnEntry[]) {
  return {
    agents: entries.length,
    inputTokens: entries.reduce((total, entry) => total + entry.inputTokens, 0),
    cachedInputTokens: entries.reduce((total, entry) => total + entry.cachedInputTokens, 0),
    outputTokens: entries.reduce((total, entry) => total + entry.outputTokens, 0),
    costUsd: sumCost(entries),
  };
}

/** Archived agents are excluded: they cannot spend anything further. */
export function activeAgents(agents: AgentLike[]): AgentLike[] {
  return agents.filter((agent) => !agent.archivedAt);
}
