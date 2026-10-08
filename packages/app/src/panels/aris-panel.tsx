/* eslint-disable jsx-no-new-object-as-prop -- ARIS panel uses inline styles for rapid prototyping */
import { ActivityIndicator, Text, View } from "react-native";
import { Network } from "lucide-react-native";
import { definePanel, type PanelDescriptor } from "@/panels/panel-registry";
import { usePaneContext } from "@/panels/pane-context";
import { isWeb } from "@/constants/platform";
import { useArisWiki } from "@/aris/use-aris-wiki";
import { useWorkspace } from "@/stores/session-store-hooks";
import { ArisGraphView } from "@/aris/ArisGraphView.web";

function useArisPanelDescriptor(): PanelDescriptor {
  return {
    label: "ARIS graph",
    tooltip: "ARIS knowledge graph",
    subtitle: "Research wiki",
    titleState: "ready",
    icon: Network,
    statusBucket: null,
  };
}

function ArisPanel() {
  const { serverId, workspaceId } = usePaneContext();

  if (!isWeb) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
        <Text style={{ textAlign: "center", color: "#64748b" }}>
          The ARIS knowledge graph is only available on web.
        </Text>
      </View>
    );
  }

  return <ArisPanelContent serverId={serverId} workspaceId={workspaceId} />;
}

function ArisPanelContent({ serverId, workspaceId }: { serverId: string; workspaceId: string }) {
  const workspace = useWorkspace(serverId, workspaceId);
  const wikiQuery = useArisWiki(serverId, workspace?.workspaceDirectory ?? null);

  if (wikiQuery.data) {
    return <ArisGraphView wiki={wikiQuery.data} />;
  }
  if (wikiQuery.error) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
        <Text style={{ textAlign: "center", color: "#64748b" }}>{wikiQuery.error.message}</Text>
      </View>
    );
  }
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <ActivityIndicator />
    </View>
  );
}

export const arisPanelRegistration = definePanel("aris", {
  component: ArisPanel,
  useDescriptor: useArisPanelDescriptor,
});
