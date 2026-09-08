import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { listAccounts, selectAccount, usageSnapshot } from "../shared/contracts";
import { formatCost, formatPercent, formatResetsAt, formatTokens } from "./format";

function useStyles(theme: PluginTheme, compact: boolean) {
  return useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: compact ? 16 : 24, gap: compact ? 16 : 20 },
      heading: { color: theme.colors.foreground, fontSize: compact ? 18 : 22, fontWeight: "600" as const },
      caption: { color: theme.colors.foregroundMuted, fontSize: 12 },
      card: {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 10,
        padding: compact ? 12 : 16,
        gap: 8,
      },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      rowBetween: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
      },
      label: { color: theme.colors.foreground, fontSize: 14 },
      value: { color: theme.colors.foreground, fontSize: 14, fontVariant: ["tabular-nums" as const] },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      chip: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
      },
      chipActive: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.accent,
        backgroundColor: theme.colors.accent,
      },
      chipText: { color: theme.colors.foreground, fontSize: 13 },
      chipTextActive: { color: theme.colors.accentForeground, fontSize: 13 },
      track: {
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.surface2,
        overflow: "hidden" as const,
      },
      danger: { color: theme.colors.statusDanger, fontSize: 12 },
    }),
    [theme, compact],
  );
}

function toneColor(theme: PluginTheme, usedPct: number | null): string {
  if (usedPct === null) return theme.colors.accent;
  if (usedPct >= 90) return theme.colors.statusDanger;
  if (usedPct >= 70) return theme.colors.statusWarning;
  return theme.colors.statusSuccess;
}

export function ObolSurface({ theme, layout }: PluginSurfaceProps) {
  const styles = useStyles(theme, layout.compact);
  const queryClient = useQueryClient();

  const fetchAccounts = useRpc(listAccounts);
  const fetchUsage = useRpc(usageSnapshot);
  const bindAccount = useRpc(selectAccount);

  const accounts = useQuery({ queryKey: ["obol", "accounts"], queryFn: () => fetchAccounts({}) });
  const usage = useQuery({ queryKey: ["obol", "usage"], queryFn: () => fetchUsage({}) });

  const swap = useMutation({
    mutationFn: bindAccount,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["obol"] });
    },
  });

  const byProvider = useMemo(() => {
    const groups = new Map<string, { id: string; label: string }[]>();
    for (const account of accounts.data?.accounts ?? []) {
      const group = groups.get(account.provider);
      if (group) group.push({ id: account.id, label: account.label });
      else groups.set(account.provider, [{ id: account.id, label: account.label }]);
    }
    return Array.from(groups.entries()).sort(([left], [right]) => left.localeCompare(right));
  }, [accounts.data]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={{ gap: 4 }}>
        <Text style={styles.heading}>Subscriptions</Text>
        <Text style={styles.caption}>
          Binding a provider rewrites its launch environment on every session open. Swap reloads live
          agents so they reopen on the selected account.
        </Text>
      </View>

      {swap.isError ? (
        <Text style={styles.danger}>{(swap.error as Error).message}</Text>
      ) : null}

      {byProvider.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.label}>No accounts discovered</Text>
          <Text style={styles.muted}>
            Obol proposes one account per `~/.claude*` and `~/.codex*` directory. Add more in{" "}
            {accounts.data?.statePath ?? "the plugin state file"}.
          </Text>
        </View>
      ) : null}

      {byProvider.map(([provider, options]) => {
        const active = accounts.data?.active[provider] ?? null;
        return (
          <View key={provider} style={styles.card}>
            <View style={styles.rowBetween}>
              <Text style={styles.label}>{provider}</Text>
              <Text style={styles.muted}>{active ? `bound: ${active}` : "daemon default"}</Text>
            </View>
            <View style={[styles.row, { flexWrap: "wrap" }]}>
              {options.map((option) => {
                const isActive = option.id === active;
                return (
                  <Pressable
                    key={option.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Bind ${provider} to ${option.label}`}
                    accessibilityState={{ selected: isActive }}
                    disabled={swap.isPending}
                    style={isActive ? styles.chipActive : styles.chip}
                    onPress={() =>
                      swap.mutate({ provider, accountId: option.id, reloadAgents: true })
                    }
                  >
                    <Text style={isActive ? styles.chipTextActive : styles.chipText}>
                      {option.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            {swap.isPending ? <Text style={styles.muted}>Swapping…</Text> : null}
            {swap.data && swap.data.provider === provider ? (
              <Text style={styles.muted}>
                Reloaded {swap.data.reloadedAgentIds.length} agent(s)
                {swap.data.deferredAgentIds.length > 0
                  ? `, ${swap.data.deferredAgentIds.length} mid-turn deferred to next open`
                  : ""}
                {swap.data.reloadErrors.length > 0
                  ? `, ${swap.data.reloadErrors.length} failed`
                  : ""}
              </Text>
            ) : null}
          </View>
        );
      })}

      <View style={{ gap: 4 }}>
        <Text style={styles.heading}>Subscription windows</Text>
        <Text style={styles.caption}>
          Live quota for the account each provider is currently bound to. Paseo's fetchers read the
          daemon's own credential context, so these are not per-account probes.
        </Text>
      </View>

      {usage.data?.quotaError ? (
        <Text style={styles.danger}>{usage.data.quotaError}</Text>
      ) : null}

      {(usage.data?.quotas ?? []).map((quota) => (
        <View key={quota.providerId} style={styles.card}>
          <View style={styles.rowBetween}>
            <Text style={styles.label}>{quota.displayName}</Text>
            <Text style={styles.muted}>{quota.planLabel ?? quota.status}</Text>
          </View>
          {quota.error ? <Text style={styles.danger}>{quota.error}</Text> : null}
          {quota.windows.map((quotaWindow) => (
            <View key={quotaWindow.id} style={{ gap: 4 }}>
              <View style={styles.rowBetween}>
                <Text style={styles.muted}>{quotaWindow.label}</Text>
                <Text style={styles.value}>{formatPercent(quotaWindow.usedPct)}</Text>
              </View>
              <View style={styles.track}>
                <View
                  style={{
                    width: `${Math.min(100, Math.max(0, quotaWindow.usedPct ?? 0))}%`,
                    height: 6,
                    backgroundColor: toneColor(theme, quotaWindow.usedPct),
                  }}
                />
              </View>
              <Text style={styles.muted}>{formatResetsAt(quotaWindow.resetsAt)}</Text>
            </View>
          ))}
        </View>
      ))}

      <View style={{ gap: 4 }}>
        <Text style={styles.heading}>Last-turn consumption</Text>
        <Text style={styles.caption}>
          Tokens each live agent reported for its most recent turn. These are trace counts, not a
          cumulative total and not an invoice.
        </Text>
      </View>

      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.label}>All agents</Text>
          <Text style={styles.muted}>{usage.data?.totals.agents ?? 0} live</Text>
        </View>
        <View style={styles.rowBetween}>
          <Text style={styles.muted}>input / cached / output</Text>
          <Text style={styles.value}>
            {formatTokens(usage.data?.totals.inputTokens ?? 0)} /{" "}
            {formatTokens(usage.data?.totals.cachedInputTokens ?? 0)} /{" "}
            {formatTokens(usage.data?.totals.outputTokens ?? 0)}
          </Text>
        </View>
        <View style={styles.rowBetween}>
          <Text style={styles.muted}>reported cost</Text>
          <Text style={styles.value}>{formatCost(usage.data?.totals.costUsd ?? null)}</Text>
        </View>
      </View>

      {(usage.data?.byProvider ?? []).map((rollup) => (
        <View key={rollup.provider} style={styles.card}>
          <View style={styles.rowBetween}>
            <Text style={styles.label}>{rollup.provider}</Text>
            <Text style={styles.muted}>{rollup.agents} agent(s)</Text>
          </View>
          <View style={styles.rowBetween}>
            <Text style={styles.muted}>output tokens</Text>
            <Text style={styles.value}>{formatTokens(rollup.outputTokens)}</Text>
          </View>
          <View style={styles.rowBetween}>
            <Text style={styles.muted}>reported cost</Text>
            <Text style={styles.value}>{formatCost(rollup.costUsd)}</Text>
          </View>
        </View>
      ))}

      {(usage.data?.lastTurns ?? []).map((entry) => (
        <View key={entry.agentId} style={styles.card}>
          <View style={styles.rowBetween}>
            <Text style={styles.label}>{entry.label}</Text>
            <Text style={styles.muted}>
              {entry.provider} · {entry.status}
            </Text>
          </View>
          <View style={styles.rowBetween}>
            <Text style={styles.muted}>in / cached / out</Text>
            <Text style={styles.value}>
              {formatTokens(entry.inputTokens)} / {formatTokens(entry.cachedInputTokens)} /{" "}
              {formatTokens(entry.outputTokens)}
            </Text>
          </View>
          <View style={styles.rowBetween}>
            <Text style={styles.muted}>context used</Text>
            <Text style={styles.value}>{formatPercent(entry.contextUsedPct)}</Text>
          </View>
        </View>
      ))}

      <Text style={styles.caption}>
        {usage.data ? `Captured ${usage.data.capturedAt}` : "Loading…"}
      </Text>
    </ScrollView>
  );
}
