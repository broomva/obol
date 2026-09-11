import { describe, expect, it } from "vitest";
import type { RouterState, ScopedBinding } from "../shared/contracts";
import {
  findActiveAccount,
  historyMirrorEndpoints,
  resolveAccountFor,
  resolveSessionEnv,
  routedEnvKeys,
  upsertBinding,
} from "./routing";

const WORK = {
  id: "claude-work",
  provider: "claude",
  label: "claude (work)",
  env: { CLAUDE_CONFIG_DIR: "/home/u/.claude-work", CLAUDE_EXTRA: "1" },
};
const PERSONAL = {
  id: "claude-personal",
  provider: "claude",
  label: "claude (personal)",
  env: { CLAUDE_CONFIG_DIR: "/home/u/.claude-personal" },
};
const CODEX = {
  id: "codex-default",
  provider: "codex",
  label: "codex (default)",
  env: { CODEX_HOME: "/home/u/.codex" },
};

function state(
  active: Record<string, string>,
  bindings: ScopedBinding[] = [],
): RouterState {
  return { accounts: [WORK, PERSONAL, CODEX], active, bindings };
}

describe("routedEnvKeys", () => {
  it("collects every key any account for the provider can set", () => {
    expect(routedEnvKeys(state({}), "claude")).toEqual(["CLAUDE_CONFIG_DIR", "CLAUDE_EXTRA"]);
  });

  it("does not leak keys across providers", () => {
    expect(routedEnvKeys(state({}), "codex")).toEqual(["CODEX_HOME"]);
  });
});

describe("resolveAccountFor — scope precedence", () => {
  it("returns nothing when the provider has no binding at any scope", () => {
    expect(resolveAccountFor(state({}), { provider: "claude", agentId: "a1" })).toBeUndefined();
  });

  it("falls back to the fleet-wide provider default", () => {
    const resolved = resolveAccountFor(state({ claude: "claude-work" }), {
      provider: "claude",
      agentId: "a1",
    });
    expect(resolved).toMatchObject({ scope: "provider" });
    expect(resolved?.account.id).toBe("claude-work");
  });

  it("prefers a workspace binding over the fleet default", () => {
    const s = state({ claude: "claude-work" }, [
      { scope: "workspace", key: "w1", provider: "claude", accountId: "claude-personal" },
    ]);
    const resolved = resolveAccountFor(s, { provider: "claude", agentId: "a1", workspaceId: "w1" });
    expect(resolved).toMatchObject({ scope: "workspace" });
    expect(resolved?.account.id).toBe("claude-personal");
  });

  // The point of the whole feature: one agent can sit on a different
  // subscription from the rest of the fleet.
  it("prefers an agent binding over both the workspace and the fleet default", () => {
    const s = state({ claude: "claude-work" }, [
      { scope: "workspace", key: "w1", provider: "claude", accountId: "claude-work" },
      { scope: "agent", key: "a1", provider: "claude", accountId: "claude-personal" },
    ]);
    const resolved = resolveAccountFor(s, { provider: "claude", agentId: "a1", workspaceId: "w1" });
    expect(resolved).toMatchObject({ scope: "agent" });
    expect(resolved?.account.id).toBe("claude-personal");
  });

  it("does not apply another agent's binding", () => {
    const s = state({ claude: "claude-work" }, [
      { scope: "agent", key: "a1", provider: "claude", accountId: "claude-personal" },
    ]);
    const resolved = resolveAccountFor(s, { provider: "claude", agentId: "a2" });
    expect(resolved?.account.id).toBe("claude-work");
  });

  it("does not apply a binding belonging to another provider", () => {
    const s = state({}, [
      { scope: "agent", key: "a1", provider: "codex", accountId: "codex-default" },
    ]);
    expect(resolveAccountFor(s, { provider: "claude", agentId: "a1" })).toBeUndefined();
  });

  // A stale binding must not strand a session with no account at all.
  it("falls through to the next scope when a binding names a deleted account", () => {
    const s = state({ claude: "claude-work" }, [
      { scope: "agent", key: "a1", provider: "claude", accountId: "deleted" },
    ]);
    const resolved = resolveAccountFor(s, { provider: "claude", agentId: "a1" });
    expect(resolved).toMatchObject({ scope: "provider" });
    expect(resolved?.account.id).toBe("claude-work");
  });

  it("ignores scoped bindings when the session carries no ids", () => {
    const s = state({ claude: "claude-work" }, [
      { scope: "agent", key: "a1", provider: "claude", accountId: "claude-personal" },
    ]);
    expect(resolveAccountFor(s, { provider: "claude" })?.account.id).toBe("claude-work");
  });
});

describe("findActiveAccount", () => {
  it("reports the fleet default only", () => {
    expect(findActiveAccount(state({}), "claude")).toBeUndefined();
    expect(findActiveAccount(state({ claude: "claude-personal" }), "claude")?.id).toBe(
      "claude-personal",
    );
  });
});

describe("resolveSessionEnv", () => {
  it("leaves the request untouched when the provider is unbound", () => {
    expect(
      resolveSessionEnv(state({}), { provider: "claude" }, { KEEP: "yes" }),
    ).toBeUndefined();
  });

  it("binds the selected account's environment", () => {
    expect(
      resolveSessionEnv(state({ claude: "claude-personal" }), { provider: "claude" }, undefined),
    ).toEqual({ CLAUDE_CONFIG_DIR: "/home/u/.claude-personal" });
  });

  it("preserves environment the router does not own", () => {
    expect(
      resolveSessionEnv(state({ claude: "claude-personal" }), { provider: "claude" }, {
        COMPANY_ENV: "dev",
      }),
    ).toEqual({ COMPANY_ENV: "dev", CLAUDE_CONFIG_DIR: "/home/u/.claude-personal" });
  });

  // Without clearing the other account's keys the session would open against a
  // mix of two credential stores.
  it("clears keys owned by the account being replaced", () => {
    const previous = { CLAUDE_CONFIG_DIR: "/home/u/.claude-work", CLAUDE_EXTRA: "1" };
    expect(
      resolveSessionEnv(state({ claude: "claude-personal" }), { provider: "claude" }, previous),
    ).toEqual({ CLAUDE_CONFIG_DIR: "/home/u/.claude-personal" });
  });

  it("does not clear another provider's keys while switching this one", () => {
    const previous = { CODEX_HOME: "/home/u/.codex", CLAUDE_CONFIG_DIR: "/home/u/.claude-work" };
    expect(
      resolveSessionEnv(state({ claude: "claude-personal" }), { provider: "claude" }, previous),
    ).toEqual({
      CODEX_HOME: "/home/u/.codex",
      CLAUDE_CONFIG_DIR: "/home/u/.claude-personal",
    });
  });

  it("returns undefined when the binding is already in effect", () => {
    const already = { CLAUDE_CONFIG_DIR: "/home/u/.claude-personal" };
    expect(
      resolveSessionEnv(state({ claude: "claude-personal" }), { provider: "claude" }, already),
    ).toBeUndefined();
  });

  it("applies an agent binding over the fleet default", () => {
    const s = state({ claude: "claude-work" }, [
      { scope: "agent", key: "a1", provider: "claude", accountId: "claude-personal" },
    ]);
    expect(resolveSessionEnv(s, { provider: "claude", agentId: "a1" }, undefined)).toEqual({
      CLAUDE_CONFIG_DIR: "/home/u/.claude-personal",
    });
  });
});

describe("upsertBinding", () => {
  it("replaces a binding with the same scope, key and provider", () => {
    const s = state({}, [
      { scope: "agent", key: "a1", provider: "claude", accountId: "claude-work" },
    ]);
    const next = upsertBinding(s, {
      scope: "agent",
      key: "a1",
      provider: "claude",
      accountId: "claude-personal",
    });
    expect(next.bindings).toEqual([
      { scope: "agent", key: "a1", provider: "claude", accountId: "claude-personal" },
    ]);
  });

  it("keeps bindings that differ in scope, key or provider", () => {
    const s = state({}, [
      { scope: "agent", key: "a1", provider: "claude", accountId: "claude-work" },
      { scope: "workspace", key: "a1", provider: "claude", accountId: "claude-work" },
      { scope: "agent", key: "a2", provider: "claude", accountId: "claude-work" },
    ]);
    const next = upsertBinding(s, {
      scope: "agent",
      key: "a1",
      provider: "claude",
      accountId: "claude-personal",
    });
    expect(next.bindings).toHaveLength(3);
    expect(next.bindings.filter((b) => b.accountId === "claude-work")).toHaveLength(2);
  });

  it("does not mutate the state it was given", () => {
    const s = state({}, []);
    upsertBinding(s, { scope: "agent", key: "a1", provider: "claude", accountId: "claude-work" });
    expect(s.bindings).toEqual([]);
  });
});

describe("historyMirrorEndpoints", () => {
  const DEFAULT_ACCOUNT = {
    id: "claude-default",
    provider: "claude",
    label: "claude (default)",
    env: {},
    configDir: "/home/u/.claude",
  };
  const withDefault = (
    active: Record<string, string>,
    bindings: ScopedBinding[] = [],
  ): RouterState => ({ accounts: [WORK, PERSONAL, CODEX, DEFAULT_ACCOUNT], active, bindings });

  it("resolves both endpoints when swapping AWAY from the default account", () => {
    // The regression: composing these from `account.env` leaves `from`
    // undefined here, so the caller skips the mirror and the reopened session
    // cannot find its conversation.
    const { from, to } = historyMirrorEndpoints(
      withDefault({ claude: "claude-default" }),
      WORK,
      { provider: "claude" },
    );
    expect(from).toBe("/home/u/.claude");
    expect(to).toBe("/home/u/.claude-work");
  });

  it("resolves both endpoints when swapping INTO the default account", () => {
    const { from, to } = historyMirrorEndpoints(
      withDefault({ claude: "claude-work" }),
      DEFAULT_ACCOUNT,
      { provider: "claude" },
    );
    expect(from).toBe("/home/u/.claude-work");
    expect(to).toBe("/home/u/.claude");
  });

  it("honours the most specific binding when choosing the source", () => {
    const { from } = historyMirrorEndpoints(
      withDefault({ claude: "claude-default" }, [
        { scope: "agent", key: "a1", provider: "claude", accountId: "claude-personal" },
      ]),
      WORK,
      { provider: "claude", agentId: "a1" },
    );
    expect(from).toBe("/home/u/.claude-personal");
  });

  it("leaves the source undefined when nothing was bound before", () => {
    const { from, to } = historyMirrorEndpoints(withDefault({}), WORK, { provider: "claude" });
    expect(from).toBeUndefined();
    expect(to).toBe("/home/u/.claude-work");
  });
});
