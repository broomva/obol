import { describe, expect, it } from "vitest";
import type { RouterState } from "../shared/contracts";
import { findActiveAccount, resolveSessionEnv, routedEnvKeys } from "./routing";

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

function state(active: Record<string, string>): RouterState {
  return { accounts: [WORK, PERSONAL, CODEX], active };
}

describe("routedEnvKeys", () => {
  it("collects every key any account for the provider can set", () => {
    expect(routedEnvKeys(state({}), "claude")).toEqual(["CLAUDE_CONFIG_DIR", "CLAUDE_EXTRA"]);
  });

  it("does not leak keys across providers", () => {
    expect(routedEnvKeys(state({}), "codex")).toEqual(["CODEX_HOME"]);
  });
});

describe("findActiveAccount", () => {
  it("returns nothing when the provider has no binding", () => {
    expect(findActiveAccount(state({}), "claude")).toBeUndefined();
  });

  it("ignores a binding that names an account belonging to another provider", () => {
    expect(findActiveAccount(state({ claude: "codex-default" }), "claude")).toBeUndefined();
  });
});

describe("resolveSessionEnv", () => {
  it("leaves the request untouched when the provider is unbound", () => {
    expect(resolveSessionEnv(state({}), "claude", { KEEP: "yes" })).toBeUndefined();
  });

  it("binds the selected account's environment", () => {
    expect(resolveSessionEnv(state({ claude: "claude-personal" }), "claude", undefined)).toEqual({
      CLAUDE_CONFIG_DIR: "/home/u/.claude-personal",
    });
  });

  it("preserves environment the router does not own", () => {
    expect(
      resolveSessionEnv(state({ claude: "claude-personal" }), "claude", { COMPANY_ENV: "dev" }),
    ).toEqual({ COMPANY_ENV: "dev", CLAUDE_CONFIG_DIR: "/home/u/.claude-personal" });
  });

  // The swap this plugin exists for: work sets CLAUDE_EXTRA, personal does not.
  // Without clearing the other account's keys the session would open against a
  // mix of two credential stores.
  it("clears keys owned by the account being replaced", () => {
    const previous = { CLAUDE_CONFIG_DIR: "/home/u/.claude-work", CLAUDE_EXTRA: "1" };
    expect(resolveSessionEnv(state({ claude: "claude-personal" }), "claude", previous)).toEqual({
      CLAUDE_CONFIG_DIR: "/home/u/.claude-personal",
    });
  });

  it("does not clear another provider's keys while switching this one", () => {
    const previous = { CODEX_HOME: "/home/u/.codex", CLAUDE_CONFIG_DIR: "/home/u/.claude-work" };
    expect(resolveSessionEnv(state({ claude: "claude-personal" }), "claude", previous)).toEqual({
      CODEX_HOME: "/home/u/.codex",
      CLAUDE_CONFIG_DIR: "/home/u/.claude-personal",
    });
  });

  it("returns undefined when the binding is already in effect", () => {
    const already = { CLAUDE_CONFIG_DIR: "/home/u/.claude-personal" };
    expect(resolveSessionEnv(state({ claude: "claude-personal" }), "claude", already)).toBeUndefined();
  });

  it("rebinds when only the value differs", () => {
    const stale = { CLAUDE_CONFIG_DIR: "/home/u/.claude-work" };
    expect(resolveSessionEnv(state({ claude: "claude-personal" }), "claude", stale)).toEqual({
      CLAUDE_CONFIG_DIR: "/home/u/.claude-personal",
    });
  });
});
