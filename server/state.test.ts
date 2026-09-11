import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { RouterState } from "../shared/contracts";
import { resolveSessionEnv } from "./routing";
import { claudeProjectDirName, mirrorClaudeHistory } from "./history";
import { accountConfigDir, discoverAccounts } from "./state";

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

describe("accountConfigDir", () => {
  it("reports a path for the default account even though its env is empty", () => {
    // The regression this guards: reading `env.CLAUDE_CONFIG_DIR` for the
    // default account yields undefined, which silently disables history
    // mirroring on every swap into or out of default.
    expect(find("claude-default").env).toEqual({});
    expect(accountConfigDir(find("claude-default"))).toBe(join(home, ".claude"));
  });

  it("reports the override path for a non-default account", () => {
    expect(accountConfigDir(find("claude-work"))).toBe(join(home, ".claude-work"));
  });

  it("falls back to env for a row persisted before configDir existed", () => {
    const legacy = {
      id: "claude-default",
      provider: "claude",
      label: "claude (default)",
      env: { CLAUDE_CONFIG_DIR: "/legacy/.claude" },
    };
    expect(accountConfigDir(legacy)).toBe("/legacy/.claude");
  });

  it("is undefined when there is nothing to resolve", () => {
    expect(accountConfigDir(undefined)).toBeUndefined();
    expect(
      accountConfigDir({ id: "x", provider: "unknown-vendor", label: "x", env: {} }),
    ).toBeUndefined();
  });
});

describe("history survives a swap involving the default account", () => {
  it("mirrors a conversation from the default account into a sibling", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "obol-cwd-"));
    const dirName = await claudeProjectDirName(cwd);
    const sourceProjects = join(home, ".claude", "projects", dirName);
    await mkdir(sourceProjects, { recursive: true });
    await writeFile(join(sourceProjects, "session-abc.jsonl"), '{"t":1}\n', "utf-8");

    const from = accountConfigDir(find("claude-default"));
    const to = accountConfigDir(find("claude-work"));
    // Reading `.env.CLAUDE_CONFIG_DIR` instead would make `from` undefined and
    // the caller would skip the mirror entirely.
    expect(from).toBeDefined();
    expect(to).toBeDefined();

    const result = await mirrorClaudeHistory({
      fromConfigDir: from as string,
      toConfigDir: to as string,
      cwd,
    });
    expect(result.copied).toEqual(["session-abc.jsonl"]);
    expect(await readdir(join(home, ".claude-work", "projects", dirName))).toEqual([
      "session-abc.jsonl",
    ]);
  });
});
