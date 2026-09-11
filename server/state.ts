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

    for (const name of names.slice().sort()) {
      if (name !== defaultDir && !name.startsWith(`${defaultDir}-`)) continue;
      const isDefault = name === defaultDir;
      accounts.push({
        id: isDefault ? `${provider}-default` : `${provider}-${name.slice(defaultDir.length + 1)}`,
        provider,
        label: isDefault ? `${provider} (default)` : `${provider} (${name.slice(defaultDir.length + 1)})`,
        // The default account is the *absence* of an override, so it carries an
        // empty env. Setting the config-dir variable to the default path is not
        // a no-op: Claude Code reads `<configDir>/.credentials.json` when the
        // variable is set and the unscoped keychain item when it is not, so
        // re-asserting the default path silently moves a session onto a
        // different credential store (BRO-2518). `routedEnvKeys` still lists the
        // key because a sibling account owns it, so selecting default *removes*
        // it rather than leaving the previous account's value behind.
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
  return { accounts: Array.from(byId.values()), active: stored.active, bindings: stored.bindings };
}
