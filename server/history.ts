import { copyFile, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * `CLAUDE_CONFIG_DIR` scopes the credential store *and* the conversation store.
 * Swapping a live agent onto another account therefore moves its credentials
 * and orphans its history: the reopened session asks for a session id whose
 * `.jsonl` only exists under the account it came from, and the turn fails with
 * "No conversation found with session ID".
 *
 * Mirroring the conversation into the target account before the reload closes
 * that gap. It only ever adds files: the source account is never modified and
 * an existing target file is only replaced by a strictly newer source.
 */

const PROJECT_DIR_LENGTH_CAP = 200;

/**
 * Port of the Claude Agent SDK's project-directory encoding, matching Paseo's
 * own port at packages/server/src/server/agent/providers/claude/project-dir.ts
 * so both compute the same `projects/<dir>` name.
 */
export function encodeProjectDirName(canonicalPath: string): string {
  const replaced = canonicalPath.replace(/[^a-zA-Z0-9]/g, "-");
  if (replaced.length <= PROJECT_DIR_LENGTH_CAP) return replaced;
  return `${replaced.slice(0, PROJECT_DIR_LENGTH_CAP)}-${hashSuffix(canonicalPath)}`;
}

function hashSuffix(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function normalizeProjectPath(input: string): string {
  return process.platform === "darwin" ? input.normalize("NFC") : input;
}

export async function claudeProjectDirName(cwd: string): Promise<string> {
  try {
    return encodeProjectDirName(normalizeProjectPath(await realpath(cwd)));
  } catch {
    return encodeProjectDirName(normalizeProjectPath(cwd));
  }
}

async function modifiedAt(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

export interface MirrorResult {
  copied: string[];
  skipped: string[];
}

export async function mirrorClaudeHistory(options: {
  fromConfigDir: string;
  toConfigDir: string;
  cwd: string;
}): Promise<MirrorResult> {
  const { fromConfigDir, toConfigDir, cwd } = options;
  const result: MirrorResult = { copied: [], skipped: [] };
  if (fromConfigDir === toConfigDir) return result;

  const dirName = await claudeProjectDirName(cwd);
  const sourceDir = join(fromConfigDir, "projects", dirName);
  const targetDir = join(toConfigDir, "projects", dirName);

  let names: string[];
  try {
    names = (await readdir(sourceDir)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return result;
  }
  if (names.length === 0) return result;

  await mkdir(targetDir, { recursive: true });
  for (const name of names) {
    const source = join(sourceDir, name);
    const target = join(targetDir, name);
    const sourceTime = await modifiedAt(source);
    const targetTime = await modifiedAt(target);
    if (targetTime !== null && sourceTime !== null && targetTime >= sourceTime) {
      result.skipped.push(name);
      continue;
    }
    await copyFile(source, target);
    result.copied.push(name);
  }
  return result;
}
