import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fake.home };
});

import { accountConfigDir, loadStateWithDiscovery } from "./state";

let previousPaseoHome: string | undefined;

beforeAll(async () => {
  fake.home = await mkdtemp(join(tmpdir(), "obol-upgrade-"));
  for (const dir of [".claude", ".claude-work"]) {
    await mkdir(join(fake.home, dir), { recursive: true });
  }
  previousPaseoHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = fake.home;
  await mkdir(join(fake.home, "obol"), { recursive: true });

  // State as it was persisted *before* BRO-2518: the default account carrying a
  // CLAUDE_CONFIG_DIR in its env, which is precisely the binding that broke
  // every session it touched.
  await writeFile(
    join(fake.home, "obol", "state.json"),
    JSON.stringify({
      accounts: [
        {
          id: "claude-default",
          provider: "claude",
          label: "claude (default)",
          env: { CLAUDE_CONFIG_DIR: join(fake.home, ".claude") },
        },
        {
          id: "claude-retired",
          provider: "claude",
          label: "claude (retired)",
          env: { CLAUDE_CONFIG_DIR: "/gone/.claude-retired" },
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

describe("loadStateWithDiscovery", () => {
  it("replaces a stale persisted default account rather than preserving it", async () => {
    const state = await loadStateWithDiscovery();
    const account = state.accounts.find((entry) => entry.id === "claude-default");
    // Without discovery winning, the row above survives and keeps injecting the
    // variable forever — the fix would ship and never take effect.
    expect(account?.env).toEqual({});
    expect(accountConfigDir(account)).toBe(join(fake.home, ".claude"));
  });

  it("keeps a stored account that discovery no longer finds", async () => {
    const state = await loadStateWithDiscovery();
    const retired = state.accounts.find((entry) => entry.id === "claude-retired");
    expect(retired?.env).toEqual({ CLAUDE_CONFIG_DIR: "/gone/.claude-retired" });
  });

  it("preserves the stored selection and bindings", async () => {
    const state = await loadStateWithDiscovery();
    expect(state.active).toEqual({ claude: "claude-default" });
    expect(state.bindings).toEqual([]);
  });
});
