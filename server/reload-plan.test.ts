import { describe, expect, it } from "vitest";
import type { RouterState, ScopedBinding } from "../shared/contracts";
import type { AgentLike } from "./ledger";
import { planAgentReloads } from "./reload-plan";

const WORK = { id: "work", provider: "claude", label: "work", env: { CLAUDE_CONFIG_DIR: "/w" } };
const PERSONAL = { id: "personal", provider: "claude", label: "personal", env: { CLAUDE_CONFIG_DIR: "/p" } };
const CODEX = { id: "codex", provider: "codex", label: "codex", env: { CODEX_HOME: "/c" } };

function state(active: Record<string, string>, bindings: ScopedBinding[] = []): RouterState {
  return { accounts: [WORK, PERSONAL, CODEX], active, bindings };
}

function agent(overrides: Partial<AgentLike> & { id: string }): AgentLike {
  return { provider: "claude", status: "idle", ...overrides };
}

describe("planAgentReloads", () => {
  it("reloads idle agents whose account changed", () => {
    const plan = planAgentReloads(
      [agent({ id: "a" }), agent({ id: "b" })],
      state({ claude: "work" }),
      state({ claude: "personal" }),
    );
    expect(plan).toEqual({ reload: ["a", "b"], defer: [], unaffected: [] });
  });

  // Reloading interrupts a turn in flight; deferring costs nothing because the
  // router is re-consulted when the session next opens.
  it("defers an agent that is mid-turn instead of interrupting it", () => {
    const plan = planAgentReloads(
      [agent({ id: "busy", status: "running" }), agent({ id: "free" })],
      state({ claude: "work" }),
      state({ claude: "personal" }),
    );
    expect(plan.reload).toEqual(["free"]);
    expect(plan.defer).toEqual(["busy"]);
  });

  it("defers an agent that is still initializing", () => {
    const plan = planAgentReloads(
      [agent({ id: "boot", status: "initializing" })],
      state({ claude: "work" }),
      state({ claude: "personal" }),
    );
    expect(plan.defer).toEqual(["boot"]);
  });

  // The reason the plan compares effective accounts rather than filtering by
  // provider: an agent pinned to its own account did not change subscription,
  // so reopening its session would cost a turn and buy nothing.
  it("leaves an agent pinned to another account untouched when the fleet default moves", () => {
    const pinned: ScopedBinding[] = [
      { scope: "agent", key: "pinned", provider: "claude", accountId: "personal" },
    ];
    const plan = planAgentReloads(
      [agent({ id: "pinned" }), agent({ id: "follower" })],
      state({ claude: "work" }, pinned),
      state({ claude: "personal" }, pinned),
    );
    expect(plan.reload).toEqual(["follower"]);
    expect(plan.unaffected).toEqual(["pinned"]);
  });

  it("reloads only the pinned agent when its own binding changes", () => {
    const plan = planAgentReloads(
      [agent({ id: "pinned" }), agent({ id: "other" })],
      state({ claude: "work" }, [
        { scope: "agent", key: "pinned", provider: "claude", accountId: "work" },
      ]),
      state({ claude: "work" }, [
        { scope: "agent", key: "pinned", provider: "claude", accountId: "personal" },
      ]),
    );
    expect(plan.reload).toEqual(["pinned"]);
    expect(plan.unaffected).toEqual(["other"]);
  });

  it("moves only the agents in a workspace when its binding changes", () => {
    const inside = agent({ id: "inside", workspaceId: "w1" });
    const outside = agent({ id: "outside", workspaceId: "w2" });
    const plan = planAgentReloads(
      [inside, outside],
      state({ claude: "work" }),
      state({ claude: "work" }, [
        { scope: "workspace", key: "w1", provider: "claude", accountId: "personal" },
      ]),
    );
    expect(plan.reload).toEqual(["inside"]);
    expect(plan.unaffected).toEqual(["outside"]);
  });

  it("leaves other providers alone", () => {
    const plan = planAgentReloads(
      [agent({ id: "c", provider: "codex" }), agent({ id: "a" })],
      state({ claude: "work", codex: "codex" }),
      state({ claude: "personal", codex: "codex" }),
    );
    expect(plan.reload).toEqual(["a"]);
    expect(plan.unaffected).toEqual(["c"]);
  });

  it("ignores archived agents entirely", () => {
    const plan = planAgentReloads(
      [agent({ id: "gone", archivedAt: "2026-01-01T00:00:00Z" }), agent({ id: "here" })],
      state({ claude: "work" }),
      state({ claude: "personal" }),
    );
    expect(plan.reload).toEqual(["here"]);
    expect([...plan.defer, ...plan.unaffected]).toEqual([]);
  });

  it("never lists an agent in more than one bucket, and lists every live agent once", () => {
    const agents = [
      agent({ id: "a", status: "running" }),
      agent({ id: "b" }),
      agent({ id: "c", provider: "codex" }),
    ];
    const plan = planAgentReloads(
      agents,
      state({ claude: "work", codex: "codex" }),
      state({ claude: "personal", codex: "codex" }),
    );
    const all = [...plan.reload, ...plan.defer, ...plan.unaffected];
    expect(all.sort()).toEqual(["a", "b", "c"]);
    expect(new Set(all).size).toBe(all.length);
  });
});
