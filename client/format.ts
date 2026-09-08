/** Compact token counts: 1_234_567 -> "1.23M". Exact below 1000. */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return "-";
  if (Math.abs(value) < 1000) return String(value);
  if (Math.abs(value) < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

/** `null` means "no agent reported a cost", which is not the same as $0.00. */
export function formatCost(value: number | null): string {
  if (value === null) return "not reported";
  return `$${value.toFixed(2)}`;
}

export function formatPercent(value: number | null): string {
  if (value === null) return "-";
  return `${value.toFixed(0)}%`;
}

/** Relative reset time, e.g. "resets in 2h 15m". Past instants read "elapsed". */
export function formatResetsAt(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "";
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return "";
  const deltaMs = target - now;
  if (deltaMs <= 0) return "resets now";
  const minutes = Math.floor(deltaMs / 60_000);
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours >= 1) return `resets in ${hours}h ${minutes % 60}m`;
  return `resets in ${minutes}m`;
}
