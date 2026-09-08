import { type AgentLike, activeAgents } from "./ledger";

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
}

export function planAgentReloads(agents: AgentLike[], provider: string): ReloadPlan {
  const plan: ReloadPlan = { reload: [], defer: [] };
  for (const agent of activeAgents(agents)) {
    if (agent.provider !== provider) continue;
    if (BUSY_STATUSES.has(agent.status)) plan.defer.push(agent.id);
    else plan.reload.push(agent.id);
  }
  return plan;
}
