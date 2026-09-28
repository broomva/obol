import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Account, type RouterState, RouterStateSchema } from "../shared/contracts";

/**
 * Paseo persists its own state as plain JSON with atomic writes and no
 * migrations (docs/data-model.md); the plugin follows the same shape so a
 * partially written file can never be read back as a valid binding.
 */
function paseoHome(): string {
  return process.env.PASEO_HOME ?? join(homedir(), ".paseo");
}

export function statePath(): string {
  return join(paseoHome(), "obol", "state.json");
}

/**
 * Each provider's config-dir variable. Paseo itself reads both, so pointing
 * them at a per-account directory is what makes two subscriptions of the same
 * vendor coexist.
 *
 * The store is keyed by *whether the variable is set*, not only by its value:
 * with `CLAUDE_CONFIG_DIR` unset Claude Code authenticates from the unscoped
 * keychain item, and with it set — even to the default path — it authenticates
 * from `<configDir>/.credentials.json`. Only a non-default account may carry
 * one of these keys; see `discoverAccounts`.
 */
const PROVIDER_CONFIG_DIR_ENV: Record<string, string> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
};

const PROVIDER_DEFAULT_DIR: Record<string, string> = {
  claude: ".claude",
  codex: ".codex",
};

async function directoryNames(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Finds sibling config directories that look like alternate accounts:
 * `~/.claude` is the default, `~/.claude-work` is a second subscription. This
 * only proposes rows — nothing is bound until the user selects one.
 */
export async function discoverAccounts(home = homedir()): Promise<Account[]> {
  const names = await directoryNames(home);
  const accounts: Account[] = [];

  for (const [provider, defaultDir] of Object.entries(PROVIDER_DEFAULT_DIR)) {
    const envKey = PROVIDER_CONFIG_DIR_ENV[provider];
    if (!envKey) continue;

    const sorted = names.slice().sort();
    // `<provider>-default` is reserved for the default DIRECTORY whether or not it
    // exists. Without the reservation, a lone `~/.claude-default` takes the id, and
    // it would then CHANGE if `~/.claude` later appeared — silently breaking any
    // persisted binding that referenced it. (An earlier reservation was deleted as
    // an equivalent mutant; it was, for the reason given then. This one is reachable
    // and is killed by the absent-default-dir test.)
    const used = new Set<string>([`${provider}-default`]);
    // `~/.claude-default` derives the suffix "default" and wants the same id as
    // the real default; whichever is emitted last wins the merge map, so the
    // sibling would answer to "claude-default" and route the default account at
    // a directory instead of the unscoped store (BRO-2518 round 2).
    //
    // The invariant that prevents it: the default directory takes
    // `<provider>-default` UNCONDITIONALLY (no collision check), and only a
    // sibling can be pushed off it. Two earlier attempts to also force the
    // iteration order were both equivalent mutants and were removed; the
    // `!isDefault` guard below is the whole of the protection, and it holds
    // whichever name is visited first.
    for (const name of sorted) {
      if (name !== defaultDir && !name.startsWith(`${defaultDir}-`)) continue;
      const isDefault = name === defaultDir;
      const suffix = isDefault ? "default" : name.slice(defaultDir.length + 1);
      let id = `${provider}-${suffix}`;
      if (!isDefault && used.has(id)) {
        // Deterministic disambiguation. A real directory is never silently
        // dropped, and the reserved default id is never reassigned.
        let n = 2;
        while (used.has(`${id}-${n}`)) n += 1;
        id = `${id}-${n}`;
      }
      used.add(id);
      accounts.push({
        id,
        provider,
        label: `${provider} (${id.slice(provider.length + 1)})`,
        // The default account is the *absence* of an override, so it carries an
        // empty env. Setting the config-dir variable to the default path is not
        // a no-op: Claude Code reads `<configDir>/.credentials.json` when the
        // variable is set and the unscoped keychain item when it is not, so
        // re-asserting the default path silently moves a session onto a
        // different credential store (BRO-2518). `routedEnvKeys` lists the key
        // unconditionally for the provider, so selecting default *removes* it
        // rather than leaving the previous account's value behind.
        env: isDefault ? {} : { [envKey]: join(home, name) },
        // The path is recorded for every account, default included: history
        // lives here even when nothing is injected to select it.
        configDir: join(home, name),
      });
    }
  }

  return accounts;
}

/**
 * Where an account's files live, for code that must *read or move* them rather
 * than select them — conversation history above all.
 *
 * Falls back to the launch override so state persisted before `configDir`
 * existed still resolves: those rows carried the path in `env`, including the
 * default account's, which is exactly the conflation this field undoes.
 */
/**
 * The launch variable that selects a config dir for this provider, whether or
 * not any discovered account advertises it. `routedEnvKeys` needs this
 * independently of the account list: the default account's env is empty by
 * design, so on a machine with no sibling directories the routed-key set would
 * otherwise be empty and a previously-set override would survive "select
 * default" untouched (BRO-2518 round 2).
 */
export function providerConfigDirEnv(provider: string): string | undefined {
  return PROVIDER_CONFIG_DIR_ENV[provider];
}

export function accountConfigDir(account: Account | undefined): string | undefined {
  if (!account) return undefined;
  if (account.configDir) return account.configDir;
  const envKey = PROVIDER_CONFIG_DIR_ENV[account.provider];
  return envKey ? account.env[envKey] : undefined;
}

function emptyState(): RouterState {
  return { accounts: [], active: {}, bindings: [] };
}

export async function loadState(): Promise<RouterState> {
  try {
    const raw = await readFile(statePath(), "utf-8");
    const parsed = RouterStateSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // No state yet, or unreadable; fall through to discovery.
  }
  return emptyState();
}

export async function saveState(state: RouterState): Promise<void> {
  const target = statePath();
  await mkdir(join(paseoHome(), "obol"), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  await rename(temporary, target);
}

/**
 * Merges discovered accounts into the stored state without ever overwriting a
 * binding the user chose. Discovery adds rows; only `selectAccount` binds one.
 */
/**
 * Force the invariant on a row no matter where it came from: the provider
 * default never carries a config-dir override.
 *
 * Discovery already builds it that way, but a row persisted before BRO-2518
 * carries the override, and discovery only replaces rows whose directory it can
 * still see. With `~/.claude` temporarily absent the stale row would survive and
 * keep injecting the key. The path is not thrown away — it becomes `configDir`,
 * which is where that account's history actually lives.
 */
export function normalizeAccount(account: Account, home = homedir()): Account {
  const envKey = PROVIDER_CONFIG_DIR_ENV[account.provider];
  const defaultDir = PROVIDER_DEFAULT_DIR[account.provider];
  if (!envKey || !defaultDir) return account;
  if (!(envKey in account.env)) return account;
  // Default-ness is a property of the DIRECTORY, never of the id. `~/.claude-default`
  // derives the id `claude-default` too, and keying this off the id stripped that
  // sibling's override and turned it into a false default pointing at the unscoped
  // store (BRO-2518 round 3). Deciding by path is the same lesson as the original
  // bug: two facts that coincide for the common case are still two facts.
  const path = account.configDir ?? account.env[envKey];
  if (path !== join(home, defaultDir)) return account;
  const { [envKey]: legacyPath, ...rest } = account.env;
  return { ...account, env: rest, configDir: account.configDir ?? legacyPath };
}

export async function loadStateWithDiscovery(): Promise<RouterState> {
  const stored = await loadState();
  const discovered = await discoverAccounts();
  const byId = new Map(stored.accounts.map((account) => [account.id, account]));
  // Discovery is authoritative for anything it finds. Accounts are derived from
  // the filesystem and carry no user-authored fields, so a stored row is only a
  // cache — and letting the cache win means a row persisted with an older shape
  // survives forever. That is how a default account persisted with a
  // `CLAUDE_CONFIG_DIR` in its env would keep injecting it after BRO-2518 was
  // fixed. Stored rows that discovery no longer finds are still kept, so an
  // account whose directory is temporarily absent is not silently dropped.
  for (const account of discovered) byId.set(account.id, account);
  return {
    accounts: Array.from(byId.values()).map((account) => normalizeAccount(account)),
    active: stored.active,
    bindings: stored.bindings,
  };
}
