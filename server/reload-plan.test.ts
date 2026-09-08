import { describe, expect, it } from "vitest";
import type { AgentLike } from "./ledger";
import { planAgentReloads } from "./reload-plan";

function agent(overrides: Partial<AgentLike> & { id: string }): AgentLike {
  return { provider: "claude", status: "idle", ...overrides };
}

describe("planAgentReloads", () => {
  it("reloads idle agents of the bound provider", () => {
    const plan = planAgentReloads([agent({ id: "a" }), agent({ id: "b" })], "claude");
    expect(plan).toEqual({ reload: ["a", "b"], defer: [] });
  });

  // Reloading interrupts a turn in flight. On a daemon with live work that
  // destroys it — including the agent that may be driving the swap.
  it("defers an agent that is mid-turn instead of interrupting it", () => {
    const plan = planAgentReloads(
      [agent({ id: "busy", status: "running" }), agent({ id: "free", status: "idle" })],
      "claude",
    );
    expect(plan).toEqual({ reload: ["free"], defer: ["busy"] });
  });

  it("defers an agent that is still initializing", () => {
    const plan = planAgentReloads([agent({ id: "boot", status: "initializing" })], "claude");
    expect(plan).toEqual({ reload: [], defer: ["boot"] });
  });

  it("leaves other providers alone", () => {
    const plan = planAgentReloads(
      [agent({ id: "c", provider: "codex" }), agent({ id: "a", provider: "claude" })],
      "claude",
    );
    expect(plan).toEqual({ reload: ["a"], defer: [] });
  });

  it("ignores archived agents entirely", () => {
    const plan = planAgentReloads(
      [agent({ id: "gone", archivedAt: "2026-01-01T00:00:00Z" }), agent({ id: "here" })],
      "claude",
    );
    expect(plan).toEqual({ reload: ["here"], defer: [] });
  });

  it("never lists an agent in both buckets", () => {
    const agents = [
      agent({ id: "a", status: "running" }),
      agent({ id: "b", status: "idle" }),
      agent({ id: "c", status: "error" }),
    ];
    const plan = planAgentReloads(agents, "claude");
    expect(plan.reload.filter((id) => plan.defer.includes(id))).toEqual([]);
    expect([...plan.reload, ...plan.defer].sort()).toEqual(["a", "b", "c"]);
  });
});
