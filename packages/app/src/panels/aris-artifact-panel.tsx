/* eslint-disable jsx-no-new-object-as-prop -- ARIS panel uses inline styles for rapid prototyping */
import { ActivityIndicator, Text, View } from "react-native";
import { Layers } from "lucide-react-native";
import type { ArisWorkflowStage, ArisWorkflowStageId } from "@getpaseo/protocol/messages";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { usePaneContext } from "@/panels/pane-context";
import { isWeb } from "@/constants/platform";
import { useArisWorkflowStatus } from "@/aris/use-aris-workflow-status";
import { WorkflowArtifactList } from "@/aris/views/WorkflowArtifactList.web";

const STAGE_NAMES: Record<ArisWorkflowStageId, string> = {
  W1: "Idea discovery",
  "W1.5": "Review bridge",
  W2: "Auto review loop",
  W3: "Experiment bridge",
  W4: "Experiments",
  W5: "Paper drafting",
  W6: "Manuscript",
};

function useArisArtifactPanelDescriptor(target: {
  kind: "aris-artifact";
  stageId: ArisWorkflowStageId;
}): PanelDescriptor {
  return {
    label: `${target.stageId} · ${STAGE_NAMES[target.stageId]}`,
    subtitle: `ARIS artifact · ${target.stageId}`,
    titleState: "ready",
    icon: Layers,
    statusBucket: null,
  };
}

function ArisArtifactPanel() {
  const { serverId, workspaceId, target } = usePaneContext();
  if (target.kind !== "aris-artifact") {
    return null;
  }

  if (!isWeb) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
        <Text style={{ textAlign: "center", color: "#64748b" }}>
          ARIS visualization is only available on web.
        </Text>
      </View>
    );
  }

  return (
    <ArisArtifactPanelContent
      serverId={serverId}
      workspaceId={workspaceId}
      stageId={target.stageId}
    />
  );
}

function ArisArtifactPanelContent({
  serverId,
  workspaceId,
  stageId,
}: {
  serverId: string;
  workspaceId: string;
  stageId: ArisWorkflowStageId;
}) {
  const { data, isLoading, isError, error } = useArisWorkflowStatus(serverId, workspaceId);

  if (isLoading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }

  if (isError) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
        <Text style={{ textAlign: "center", color: "#ef4444" }}>{error ?? "..."}</Text>
      </View>
    );
  }

  if (data && !data.ok) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
        <Text style={{ textAlign: "center", color: "#ef4444" }}>
          {data.error ?? "The host could not read the workflow status."}
        </Text>
      </View>
    );
  }

  const stage: ArisWorkflowStage | null =
    data?.status?.stages?.find((item) => item.id === stageId) ?? null;

  if (!stage) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
        <Text style={{ textAlign: "center", color: "#64748b" }}>
          Stage {stageId} not found in current workflow status.
        </Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <WorkflowArtifactList stage={stage} />
    </View>
  );
}

export const arisArtifactPanelRegistration: PanelRegistration<"aris-artifact"> = {
  kind: "aris-artifact",
  component: ArisArtifactPanel,
  useDescriptor: useArisArtifactPanelDescriptor,
};
