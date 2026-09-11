import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { RouterState } from "../shared/contracts";
import { resolveSessionEnv } from "./routing";
import { discoverAccounts } from "./state";

/**
 * A home holding the product of the two conditions that decide whether an
 * account may carry a config-dir key: default vs sibling, across both
 * providers. A suite that only looked at one side of that boundary could not
 * fail for the boundary.
 */
let home: string;
let accounts: Awaited<ReturnType<typeof discoverAccounts>>;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "obol-state-"));
  for (const dir of [".claude", ".claude-work", ".codex", ".codex-alt"]) {
    await mkdir(join(home, dir), { recursive: true });
  }
  accounts = await discoverAccounts(home);
});

const find = (id: string) => {
  const account = accounts.find((entry) => entry.id === id);
  if (!account) throw new Error(`no account ${id}; got ${accounts.map((a) => a.id).join(",")}`);
  return account;
};

describe("discoverAccounts", () => {
  it("gives the default claude account an empty env, not the default path", () => {
    // BRO-2518: setting CLAUDE_CONFIG_DIR to ~/.claude is not a no-op — Claude
    // Code authenticates from <configDir>/.credentials.json when the variable
    // is set and from the unscoped keychain item when it is not.
    expect(find("claude-default").env).toEqual({});
    expect(find("claude-default").env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
  });

  it("gives the default codex account an empty env", () => {
    expect(find("codex-default").env).toEqual({});
    expect(find("codex-default").env).not.toHaveProperty("CODEX_HOME");
  });

  it("still points a non-default claude account at its own config dir", () => {
    expect(find("claude-work").env).toEqual({ CLAUDE_CONFIG_DIR: join(home, ".claude-work") });
  });

  it("still points a non-default codex account at its own config dir", () => {
    expect(find("codex-alt").env).toEqual({ CODEX_HOME: join(home, ".codex-alt") });
  });
});

describe("selecting the default account clears a sibling's override", () => {
  const state = (): RouterState => ({
    accounts,
    active: { claude: "claude-default" },
    bindings: [],
  });

  it("removes CLAUDE_CONFIG_DIR left behind by the account it replaces", () => {
    const next = resolveSessionEnv(state(), { provider: "claude" }, {
      CLAUDE_CONFIG_DIR: join(home, ".claude-work"),
    });
    // Not merely "different" — the key must be gone. If the default account
    // re-asserted the default path this would be a rebind onto a second store.
    expect(next).toEqual({});
    expect(next).not.toHaveProperty("CLAUDE_CONFIG_DIR");
  });

  it("leaves a session that already has no override untouched", () => {
    expect(resolveSessionEnv(state(), { provider: "claude" }, {})).toBeUndefined();
  });

  it("does not disturb another provider's variables", () => {
    const next = resolveSessionEnv(state(), { provider: "claude" }, {
      CLAUDE_CONFIG_DIR: join(home, ".claude-work"),
      CODEX_HOME: join(home, ".codex-alt"),
    });
    expect(next).toEqual({ CODEX_HOME: join(home, ".codex-alt") });
  });
});
