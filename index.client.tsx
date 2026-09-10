import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ObolSurface } from "./client/surface";
import { selectAccount } from "./shared/contracts";

export default function contribute(client: PluginClientContext) {
  client.addSurface("obol", ObolSurface);
  client.addSidebarItem({
    id: "obol",
    title: "Obol",
    icon: "Coins",
    surface: "obol",
  });
  client.addCommandCenterItem({
    id: "open-obol",
    title: "Open subscriptions and usage",
    icon: "Coins",
    context: "global",
    onSelect({ openSurface }) {
      openSurface("obol");
    },
  });

  /**
   * Pins one agent to one account. This is the case a single global switch
   * cannot express: the rest of the fleet stays where it is, and only this
   * agent moves. With no argument it opens the panel instead.
   */
  client.addSlashCommand({
    name: "obol",
    description: "Bind this agent to a subscription account",
    argumentHint: "[account-id]",
    context: "agent",
    async onSubmit({ args, agent, rpc, openSurface }) {
      const accountId = args.trim();
      if (!accountId) {
        openSurface("obol");
        return;
      }
      await rpc(selectAccount, {
        provider: agent.provider,
        accountId,
        scope: "agent",
        key: agent.id,
        reloadAgents: true,
      });
    },
  });

  return () => {};
}
