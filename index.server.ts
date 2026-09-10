import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listAccounts, selectAccount, usageSnapshot } from "./shared/contracts";
import { handleListAccounts, handleSelectAccount, handleUsageSnapshot } from "./server/handlers";
import { resolveAccountFor, resolveSessionEnv } from "./server/routing";
import { loadStateWithDiscovery } from "./server/state";

export default function contribute(server: PluginServerContext) {
  server.handle(listAccounts, handleListAccounts);
  server.handle(selectAccount, handleSelectAccount);
  server.handle(usageSnapshot, handleUsageSnapshot);

  /**
   * The swap itself. Paseo runs this on create, resume, refresh and import, and
   * does not persist env overrides with the agent, so the active binding is
   * re-applied every time a provider session opens. Reloading an agent after a
   * select is therefore enough to move it onto another subscription.
   */
  server.before("agent.session_open", async ({ request }) => {
    const state = await loadStateWithDiscovery();
    const context = {
      provider: request.provider,
      agentId: request.agentId,
      workspaceId: request.workspaceId,
    };
    const env = resolveSessionEnv(state, context, request.env);
    if (!env) return undefined;
    const resolved = resolveAccountFor(state, context);
    // Which account a session opened on is the one fact an operator needs when
    // a turn fails on the wrong subscription. Keys only: the values are
    // credential-store paths.
    console.log(
      `[obol] bound ${request.provider} -> ${resolved?.account.id} ` +
        `via ${resolved?.scope} (${request.reason}, keys: ${Object.keys(env).sort().join(",")})`,
    );
    return { ...request, env };
  });

  return () => {};
}
