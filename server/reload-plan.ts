import type { RouterState } from "../shared/contracts";
import { type AgentLike, activeAgents } from "./ledger";
import { resolveAccountFor } from "./routing";

/**
 * Reloading an agent closes and reopens its provider session, and Paseo
 * interrupts a running turn to do it (`interruptAgentIfRunning` in
 * session.ts). On a daemon with live work — which includes the agent that may
 * be driving this very swap — that destroys a turn in flight.
 *
 * So a swap reloads only agents that are not mid-turn. A busy agent is
 * deferred, not skipped silently: it picks the new binding up the next time its
 * session opens, because the router is re-consulted on every open.
 */
const BUSY_STATUSES = new Set(["running", "initializing"]);

export interface ReloadPlan {
  reload: string[];
  defer: string[];
  /** Effective account unchanged — reloading these would be pure disruption. */
  unaffected: string[];
}

function contextOf(agent: AgentLike) {
  return {
    provider: agent.provider,
    agentId: agent.id,
    workspaceId: agent.workspaceId ?? null,
  };
}

/**
 * Which agents a binding change actually moves.
 *
 * An agent is affected only when its *effective* account differs between the
 * two states. Scope precedence means a new fleet-wide default must leave an
 * agent that pinned itself to another account completely alone — it did not
 * change subscription, so reopening its session would cost a turn and buy
 * nothing.
 */
export function planAgentReloads(
  agents: AgentLike[],
  before: RouterState,
  after: RouterState,
): ReloadPlan {
  const plan: ReloadPlan = { reload: [], defer: [], unaffected: [] };

  for (const agent of activeAgents(agents)) {
    const context = contextOf(agent);
    const previous = resolveAccountFor(before, context)?.account.id ?? null;
    const next = resolveAccountFor(after, context)?.account.id ?? null;

    if (previous === next) {
      plan.unaffected.push(agent.id);
      continue;
    }
    if (BUSY_STATUSES.has(agent.status)) plan.defer.push(agent.id);
    else plan.reload.push(agent.id);
  }

  return plan;
}
