import type { Account, BindingScope, RouterState, ScopedBinding } from "../shared/contracts";

/** Everything the router knows about a session that is about to open. */
export interface SessionContext {
  provider: string;
  agentId?: string | null;
  workspaceId?: string | null;
}

/**
 * Keys any account for this provider could set. Switching accounts must clear
 * the keys the *other* account owned, otherwise a binding with fewer variables
 * inherits leftovers from the one it replaced and the session opens against a
 * mix of two credential stores.
 */
export function routedEnvKeys(state: RouterState, provider: string): string[] {
  const keys = new Set<string>();
  for (const account of state.accounts) {
    if (account.provider !== provider) continue;
    for (const key of Object.keys(account.env)) keys.add(key);
  }
  return Array.from(keys).sort();
}

function findBinding(
  state: RouterState,
  scope: ScopedBinding["scope"],
  key: string | null | undefined,
  provider: string,
): ScopedBinding | undefined {
  if (!key) return undefined;
  return state.bindings.find(
    (binding) =>
      binding.scope === scope && binding.key === key && binding.provider === provider,
  );
}

/**
 * Which account a session opens on, and why.
 *
 * Most specific wins: an agent's own binding, then its workspace's, then the
 * fleet-wide provider default. Returning the scope alongside the account is
 * what lets a swap decide whether a given agent's *effective* account actually
 * changed — a new provider default must not disturb an agent that has pinned
 * itself to something else.
 */
export function resolveAccountFor(
  state: RouterState,
  context: SessionContext,
): { account: Account; scope: BindingScope } | undefined {
  const { provider } = context;

  const candidates: { accountId: string; scope: BindingScope }[] = [];
  const agentBinding = findBinding(state, "agent", context.agentId, provider);
  if (agentBinding) candidates.push({ accountId: agentBinding.accountId, scope: "agent" });
  const workspaceBinding = findBinding(state, "workspace", context.workspaceId, provider);
  if (workspaceBinding) {
    candidates.push({ accountId: workspaceBinding.accountId, scope: "workspace" });
  }
  const fleetDefault = state.active[provider];
  if (fleetDefault) candidates.push({ accountId: fleetDefault, scope: "provider" });

  for (const candidate of candidates) {
    const account = state.accounts.find(
      (entry) => entry.id === candidate.accountId && entry.provider === provider,
    );
    // A binding naming an account that no longer exists falls through to the
    // next scope rather than leaving the session unbound.
    if (account) return { account, scope: candidate.scope };
  }
  return undefined;
}

/** Back-compat helper: the fleet-wide default for a provider. */
export function findActiveAccount(state: RouterState, provider: string): Account | undefined {
  return resolveAccountFor(state, { provider })?.account;
}

/**
 * The whole hot-swap mechanism. Paseo calls `agent.session_open` on create,
 * resume, refresh and import, and env overrides are not persisted with the
 * agent, so this runs fresh every time a provider session opens and the active
 * binding is always the one that takes effect.
 *
 * Returns `undefined` when nothing should change, which tells Paseo to keep the
 * request untouched.
 */
export function resolveSessionEnv(
  state: RouterState,
  context: SessionContext,
  currentEnv: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const resolved = resolveAccountFor(state, context);
  if (!resolved) return undefined;

  const next: Record<string, string> = { ...(currentEnv ?? {}) };
  for (const key of routedEnvKeys(state, context.provider)) {
    delete next[key];
  }
  Object.assign(next, resolved.account.env);

  const before = currentEnv ?? {};
  const sameSize = Object.keys(before).length === Object.keys(next).length;
  if (sameSize && Object.keys(next).every((key) => before[key] === next[key])) {
    return undefined;
  }
  return next;
}

/** Adds or replaces a scoped binding, keyed by (scope, key, provider). */
export function upsertBinding(state: RouterState, binding: ScopedBinding): RouterState {
  const rest = state.bindings.filter(
    (existing) =>
      !(
        existing.scope === binding.scope &&
        existing.key === binding.key &&
        existing.provider === binding.provider
      ),
  );
  return { ...state, bindings: [...rest, binding] };
}
