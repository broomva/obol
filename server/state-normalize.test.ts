import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fake.home };
});

import { loadStateWithDiscovery, normalizeAccount } from "./state";

let previousPaseoHome: string | undefined;

beforeAll(async () => {
  // A home with NO `.claude` directory: discovery cannot produce a default row,
  // so the stale stored one is the only thing standing.
  fake.home = await mkdtemp(join(tmpdir(), "obol-normalize-"));
  await mkdir(join(fake.home, ".claude-work"), { recursive: true });
  previousPaseoHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = fake.home;
  await mkdir(join(fake.home, "obol"), { recursive: true });
  await writeFile(
    join(fake.home, "obol", "state.json"),
    JSON.stringify({
      accounts: [
        {
          id: "claude-default",
          provider: "claude",
          label: "claude (default)",
          env: { CLAUDE_CONFIG_DIR: "/vanished/.claude" },
        },
      ],
      active: { claude: "claude-default" },
      bindings: [],
    }),
    "utf-8",
  );
});

afterAll(() => {
  if (previousPaseoHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousPaseoHome;
});

describe("normalizeAccount", () => {
  it("strips the override from a default row persisted before the fix", () => {
    const out = normalizeAccount({
      id: "claude-default",
      provider: "claude",
      label: "claude (default)",
      env: { CLAUDE_CONFIG_DIR: "/legacy/.claude" },
    });
    expect(out.env).toEqual({});
    // The path is not lost — it is where that account's history lives.
    expect(out.configDir).toBe("/legacy/.claude");
  });

  it("leaves a non-default account alone", () => {
    const work = {
      id: "claude-work",
      provider: "claude",
      label: "claude (work)",
      env: { CLAUDE_CONFIG_DIR: "/home/u/.claude-work" },
    };
    expect(normalizeAccount(work)).toEqual(work);
  });

  it("preserves other variables on a default row", () => {
    const out = normalizeAccount({
      id: "claude-default",
      provider: "claude",
      label: "claude (default)",
      env: { CLAUDE_CONFIG_DIR: "/legacy/.claude", CLAUDE_EXTRA: "1" },
    });
    expect(out.env).toEqual({ CLAUDE_EXTRA: "1" });
  });

  it("does not invent a configDir it was never given", () => {
    const out = normalizeAccount({
      id: "codex-default",
      provider: "codex",
      label: "codex (default)",
      env: {},
    });
    expect(out.configDir).toBeUndefined();
  });
});

describe("loadStateWithDiscovery with the default directory absent", () => {
  it("still refuses to let a stale default inject its override", async () => {
    // Discovery finds no `.claude`, so it cannot replace the stored row. Without
    // normalization that row survives and keeps routing sessions at a dead store.
    const state = await loadStateWithDiscovery();
    const account = state.accounts.find((entry) => entry.id === "claude-default");
    expect(account).toBeDefined();
    expect(account?.env).toEqual({});
    expect(account?.configDir).toBe("/vanished/.claude");
  });
});
