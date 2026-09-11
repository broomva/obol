/**
 * Why a reload failed, in terms a user can act on.
 *
 * Obol reopens a session by running `paseo agent reload`, because the plugin
 * SDK has no session-reopen: `DaemonClient.refreshAgent()` is the real reopen
 * and it is not exposed on the `PaseoApi` a plugin receives. That subprocess
 * authenticates on its own, and a daemon with a password gives it nothing to
 * authenticate with — the plugin's own session is IPC-backed and already
 * trusted, but the CLI's is a fresh WebSocket.
 *
 * Measured on a password-protected daemon:
 *
 *   $ paseo agent reload <id>
 *   Error: Cannot connect to daemon at <host>: Transport closed (code 1006)
 *   Start the daemon with: paseo daemon start          # exit 1
 *
 * That message names neither the real cause nor a remedy (it is the same
 * misreport as getpaseo/paseo#4508), so repeating it once per agent tells the
 * user nothing. Classify it instead.
 */

export type ReloadFailureKind = "unreachable_or_unauthenticated" | "unknown";

const CONNECT_SIGNATURES = [
  "DAEMON_NOT_RUNNING",
  "Transport closed",
  "Cannot connect to daemon",
  "Cannot reach the daemon",
  "Password required",
  "Incorrect password",
];

export function classifyReloadFailure(message: string): ReloadFailureKind {
  const haystack = message.toLowerCase();
  for (const signature of CONNECT_SIGNATURES) {
    if (haystack.includes(signature.toLowerCase())) return "unreachable_or_unauthenticated";
  }
  return "unknown";
}

/**
 * One hint for the whole swap, not one per agent. Returns `null` when nothing
 * failed or when no failure is explained by the connect/auth case.
 *
 * The binding itself is already saved when this runs, which is the part worth
 * telling the user: the swap is not lost, only deferred.
 */
export function reloadHint(errors: readonly { agentId: string; error: string }[]): string | null {
  if (errors.length === 0) return null;
  const blocked = errors.filter(
    (entry) => classifyReloadFailure(entry.error) === "unreachable_or_unauthenticated",
  );
  if (blocked.length === 0) return null;

  return (
    `The binding was saved, but ${blocked.length} agent(s) could not be reopened: ` +
    "obol reloads them with `paseo agent reload`, which authenticates separately and has no " +
    "credential for a password-protected daemon. They will pick the new account up the next time " +
    "their session opens, or reload them from the app to apply it now."
  );
}
