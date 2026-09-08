import type { Account, RouterState } from "../shared/contracts";

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

export function findActiveAccount(state: RouterState, provider: string): Account | undefined {
  const accountId = state.active[provider];
  if (!accountId) return undefined;
  return state.accounts.find(
    (account) => account.id === accountId && account.provider === provider,
  );
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
  provider: string,
  currentEnv: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const account = findActiveAccount(state, provider);
  if (!account) return undefined;

  const next: Record<string, string> = { ...(currentEnv ?? {}) };
  for (const key of routedEnvKeys(state, provider)) {
    delete next[key];
  }
  Object.assign(next, account.env);

  const before = currentEnv ?? {};
  const sameSize = Object.keys(before).length === Object.keys(next).length;
  if (sameSize && Object.keys(next).every((key) => before[key] === next[key])) {
    return undefined;
  }
  return next;
}
