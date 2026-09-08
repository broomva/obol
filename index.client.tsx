import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ObolSurface } from "./client/surface";

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
  return () => {};
}
