import { describe, expect, it } from "vitest";
import { classifyReloadFailure, reloadHint } from "./reload-diagnosis";

// Copied from a real run against a password-protected daemon, not invented:
//   $ paseo agent reload <id> --json   # exit 1, stderr
const MEASURED_JSON_ERROR =
  'Command failed: paseo agent reload 0000 --json\n{\n  "error": {\n    "code": "DAEMON_NOT_RUNNING",\n' +
  '    "message": "Cannot connect to daemon at 100.82.213.74:6767: Transport closed (code 1006)",\n' +
  '    "details": "Start the daemon with: paseo daemon start"\n  }\n}\n';

const MEASURED_PLAIN_ERROR =
  "Command failed: paseo agent reload 0000\n" +
  "Error: Cannot connect to daemon at 100.82.213.74:6767: Transport closed (code 1006)\n" +
  "Start the daemon with: paseo daemon start\n";

describe("classifyReloadFailure", () => {
  it("recognises the measured failure from a password-protected daemon", () => {
    expect(classifyReloadFailure(MEASURED_JSON_ERROR)).toBe("unreachable_or_unauthenticated");
    expect(classifyReloadFailure(MEASURED_PLAIN_ERROR)).toBe("unreachable_or_unauthenticated");
  });

  it("recognises the daemon's own auth close reasons", () => {
    expect(classifyReloadFailure("Password required")).toBe("unreachable_or_unauthenticated");
    expect(classifyReloadFailure("Incorrect password")).toBe("unreachable_or_unauthenticated");
  });

  it("recognises the 0.8 wording as well as the older one", () => {
    expect(classifyReloadFailure("Cannot reach the daemon at x: Password required")).toBe(
      "unreachable_or_unauthenticated",
    );
  });

  it("does not claim to explain an unrelated failure", () => {
    expect(classifyReloadFailure("history mirror failed: EACCES")).toBe("unknown");
    expect(classifyReloadFailure("spawn paseo ENOENT")).toBe("unknown");
    expect(classifyReloadFailure("")).toBe("unknown");
  });
});

describe("reloadHint", () => {
  it("says nothing when nothing failed", () => {
    expect(reloadHint([])).toBeNull();
  });

  it("says nothing when no failure matches the connect/auth case", () => {
    expect(reloadHint([{ agentId: "a", error: "history mirror failed: EACCES" }])).toBeNull();
  });

  // The part worth telling the user: the swap is deferred, not lost.
  it("explains the auth case once for the whole swap and names the remedy", () => {
    const hint = reloadHint([
      { agentId: "a", error: MEASURED_JSON_ERROR },
      { agentId: "b", error: MEASURED_PLAIN_ERROR },
    ]);
    expect(hint).toContain("2 agent(s)");
    expect(hint).toContain("binding was saved");
    expect(hint).toContain("next time");
    expect(hint).toContain("reload them from the app");
  });

  it("counts only the failures it actually explains", () => {
    const hint = reloadHint([
      { agentId: "a", error: MEASURED_JSON_ERROR },
      { agentId: "b", error: "history mirror failed: EACCES" },
    ]);
    expect(hint).toContain("1 agent(s)");
  });
});
