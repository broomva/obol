import { describe, expect, it } from "vitest";
import {
  type AgentLike,
  activeAgents,
  agentsFromEntries,
  rollupByProvider,
  toLastTurnEntry,
  totalsOf,
} from "./ledger";

function agent(overrides: Partial<AgentLike> & { id: string }): AgentLike {
  return { provider: "claude", status: "idle", ...overrides };
}

describe("toLastTurnEntry", () => {
  it("reads zeros for an agent that has reported no usage", () => {
    expect(toLastTurnEntry(agent({ id: "abcdef1234" }))).toEqual({
      agentId: "abcdef1234",
      label: "abcdef12",
      provider: "claude",
      status: "idle",
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      contextUsedPct: null,
    });
  });

  it("prefers the title and computes context use", () => {
    const entry = toLastTurnEntry(
      agent({
        id: "a1",
        title: "  Fix the parser  ",
        lastUsage: { contextWindowUsedTokens: 45_000, contextWindowMaxTokens: 200_000 },
      }),
    );
    expect(entry.label).toBe("Fix the parser");
    expect(entry.contextUsedPct).toBe(22.5);
  });

  it("reports no context percentage when the window size is unknown or zero", () => {
    expect(toLastTurnEntry(agent({ id: "a", lastUsage: { contextWindowUsedTokens: 10 } })).contextUsedPct).toBeNull();
    expect(
      toLastTurnEntry(agent({ id: "b", lastUsage: { contextWindowUsedTokens: 10, contextWindowMaxTokens: 0 } }))
        .contextUsedPct,
    ).toBeNull();
  });
});

describe("activeAgents", () => {
  it("drops archived agents, which cannot spend anything further", () => {
    const agents = [agent({ id: "live" }), agent({ id: "gone", archivedAt: "2026-01-01T00:00:00Z" })];
    expect(activeAgents(agents).map((entry) => entry.id)).toEqual(["live"]);
  });
});

describe("cost aggregation", () => {
  // An absent cost is unknown, not zero. Reporting $0.00 for a fleet that never
  // reported a cost would be a fabricated number.
  it("stays null when no agent reported a cost", () => {
    const entries = [agent({ id: "a" }), agent({ id: "b" })].map(toLastTurnEntry);
    expect(totalsOf(entries).costUsd).toBeNull();
    expect(rollupByProvider(entries)[0]?.costUsd).toBeNull();
  });

  it("sums only the agents that reported one", () => {
    const entries = [
      agent({ id: "a", lastUsage: { totalCostUsd: 1.5 } }),
      agent({ id: "b" }),
      agent({ id: "c", lastUsage: { totalCostUsd: 2.25 } }),
    ].map(toLastTurnEntry);
    expect(totalsOf(entries).costUsd).toBe(3.75);
  });

  it("counts a genuine zero as reported", () => {
    const entries = [agent({ id: "a", lastUsage: { totalCostUsd: 0 } })].map(toLastTurnEntry);
    expect(totalsOf(entries).costUsd).toBe(0);
  });
});

describe("rollupByProvider", () => {
  it("groups per provider and orders by output tokens", () => {
    const entries = [
      agent({ id: "a", provider: "claude", lastUsage: { outputTokens: 10, inputTokens: 5 } }),
      agent({ id: "b", provider: "codex", lastUsage: { outputTokens: 90 } }),
      agent({ id: "c", provider: "claude", lastUsage: { outputTokens: 20, cachedInputTokens: 7 } }),
    ].map(toLastTurnEntry);

    const rollup = rollupByProvider(entries);
    expect(rollup.map((row) => row.provider)).toEqual(["codex", "claude"]);
    expect(rollup[1]).toMatchObject({
      provider: "claude",
      agents: 2,
      inputTokens: 5,
      cachedInputTokens: 7,
      outputTokens: 30,
    });
  });
});

describe("totalsOf", () => {
  it("counts agents and sums each token class", () => {
    const entries = [
      agent({ id: "a", lastUsage: { inputTokens: 1, cachedInputTokens: 2, outputTokens: 3 } }),
      agent({ id: "b", lastUsage: { inputTokens: 10, cachedInputTokens: 20, outputTokens: 30 } }),
    ].map(toLastTurnEntry);
    expect(totalsOf(entries)).toEqual({
      agents: 2,
      inputTokens: 11,
      cachedInputTokens: 22,
      outputTokens: 33,
      costUsd: null,
    });
  });
});

describe("agentsFromEntries", () => {
  // agents.list() rows are { agent, project, ... }. Casting the row to an agent
  // yielded undefined fields and the first property read threw at runtime,
  // which every hand-made fixture in this file had hidden.
  it("unwraps the nested agent snapshot from a directory entry", () => {
    const entries = [
      { agent: { id: "a1", provider: "claude", status: "idle" }, project: { id: "p" } },
      { agent: { id: "a2", provider: "codex", status: "running" }, project: { id: "p" } },
    ];
    expect(agentsFromEntries(entries).map((a) => a.id)).toEqual(["a1", "a2"]);
  });

  it("drops rows with no usable agent instead of throwing", () => {
    const entries = [
      { project: { id: "p" } },
      null,
      { agent: null },
      { agent: { provider: "claude", status: "idle" } },
      { agent: { id: "good", provider: "claude", status: "idle" } },
    ];
    expect(agentsFromEntries(entries).map((a) => a.id)).toEqual(["good"]);
  });

  it("survives an entry that is not an object at all", () => {
    expect(agentsFromEntries(["nope", 7, undefined])).toEqual([]);
  });
});

describe("toLastTurnEntry label fallback", () => {
  it("does not throw when a snapshot arrives without an id", () => {
    const entry = toLastTurnEntry({ provider: "claude", status: "idle" } as AgentLike);
    expect(entry.label).toBe("unknown");
  });
});
