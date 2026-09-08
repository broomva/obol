import { mkdtemp, mkdir, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { claudeProjectDirName, encodeProjectDirName, mirrorClaudeHistory } from "./history";

describe("encodeProjectDirName", () => {
  // Must match Paseo's port of the SDK encoding, otherwise the mirrored file
  // lands in a directory the provider never reads.
  it("replaces every non-alphanumeric character with a dash", () => {
    expect(encodeProjectDirName("/private/tmp/obol-demo")).toBe("-private-tmp-obol-demo");
    expect(encodeProjectDirName("/Users/a.b/My Repo")).toBe("-Users-a-b-My-Repo");
  });

  it("caps long paths and appends a stable hash", () => {
    const long = `/${"x".repeat(400)}`;
    const encoded = encodeProjectDirName(long);
    // The cap applies to the dash-replaced string: 200 characters, then the
    // hash separator, so the leading "-" counts toward the 200.
    expect(encoded.slice(0, 200)).toBe(`-${"x".repeat(199)}`);
    expect(encoded[200]).toBe("-");
    expect(encoded.length).toBeGreaterThan(201);
    expect(encoded).toBe(encodeProjectDirName(long));
  });
});

describe("mirrorClaudeHistory", () => {
  let root: string;
  let from: string;
  let to: string;
  const cwd = "/some/project";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "obol-history-"));
    from = join(root, "from");
    to = join(root, "to");
    await mkdir(join(from, "projects", await claudeProjectDirName(cwd)), { recursive: true });
    await mkdir(to, { recursive: true });
  });

  async function writeSession(name: string, body: string): Promise<string> {
    const dir = join(from, "projects", await claudeProjectDirName(cwd));
    const path = join(dir, name);
    await writeFile(path, body, "utf-8");
    return path;
  }

  it("copies the conversation into the target account", async () => {
    await writeSession("abc.jsonl", '{"turn":1}');
    const result = await mirrorClaudeHistory({ fromConfigDir: from, toConfigDir: to, cwd });

    expect(result.copied).toEqual(["abc.jsonl"]);
    const target = join(to, "projects", await claudeProjectDirName(cwd), "abc.jsonl");
    expect(await readFile(target, "utf-8")).toBe('{"turn":1}');
  });

  it("leaves the source account untouched", async () => {
    await writeSession("abc.jsonl", '{"turn":1}');
    await mirrorClaudeHistory({ fromConfigDir: from, toConfigDir: to, cwd });

    const sourceDir = join(from, "projects", await claudeProjectDirName(cwd));
    expect(await readdir(sourceDir)).toEqual(["abc.jsonl"]);
    expect(await readFile(join(sourceDir, "abc.jsonl"), "utf-8")).toBe('{"turn":1}');
  });

  it("ignores files that are not conversations", async () => {
    await writeSession("abc.jsonl", "{}");
    await writeSession("notes.txt", "ignore me");
    const result = await mirrorClaudeHistory({ fromConfigDir: from, toConfigDir: to, cwd });
    expect(result.copied).toEqual(["abc.jsonl"]);
  });

  it("does not overwrite a target that is already at least as new", async () => {
    const source = await writeSession("abc.jsonl", "old");
    const targetDir = join(to, "projects", await claudeProjectDirName(cwd));
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, "abc.jsonl"), "newer", "utf-8");

    const past = new Date(Date.now() - 60_000);
    await utimes(source, past, past);

    const result = await mirrorClaudeHistory({ fromConfigDir: from, toConfigDir: to, cwd });
    expect(result).toEqual({ copied: [], skipped: ["abc.jsonl"] });
    expect(await readFile(join(targetDir, "abc.jsonl"), "utf-8")).toBe("newer");
  });

  it("is a no-op when the accounts share a config dir", async () => {
    await writeSession("abc.jsonl", "{}");
    const result = await mirrorClaudeHistory({ fromConfigDir: from, toConfigDir: from, cwd });
    expect(result).toEqual({ copied: [], skipped: [] });
  });

  it("is a no-op when the source has no history for that directory", async () => {
    const result = await mirrorClaudeHistory({
      fromConfigDir: from,
      toConfigDir: to,
      cwd: "/never/used",
    });
    expect(result).toEqual({ copied: [], skipped: [] });
  });
});
