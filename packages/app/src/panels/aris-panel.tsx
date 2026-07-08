/* eslint-disable jsx-no-new-object-as-prop -- ARIS panel uses inline styles for rapid prototyping */
import { ActivityIndicator, Text, View } from "react-native";
import { Network, FlaskConical, Microscope } from "lucide-react-native";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { usePaneContext } from "@/panels/pane-context";
import { isWeb } from "@/constants/platform";
import { useArisReviewQuery } from "@/aris/use-aris-review-query";
import { useArisEventsQuery } from "@/aris/use-aris-events-query";
import { useArisRunsQuery, useArisRunQuery, useArisIterationsQuery } from "@/hooks/use-aris-query";
import { ArisCockpitView } from "@/aris/ArisCockpitView.web";

function useArisPanelDescriptor(target: {
  kind: "aris";
  runId?: string;
  view?: "cockpit" | "graph" | "review";
}): PanelDescriptor {
  let viewLabel: string;
  if (target.view === "graph") {
    viewLabel = "Graph";
  } else if (target.view === "review") {
    viewLabel = "Review";
  } else {
    viewLabel = "Cockpit";
  }

  let icon: typeof Network;
  if (target.view === "graph") {
    icon = Network;
  } else if (target.view === "review") {
    icon = Microscope;
  } else {
    icon = FlaskConical;
  }

  return {
    label: `ARIS ${viewLabel}`,
    subtitle: target.runId ? `Run ${target.runId}` : "AutoResearch",
    titleState: "ready",
    icon,
    statusBucket: null,
  };
}

function ArisPanel() {
  const { serverId, workspaceId, target } = usePaneContext();
  if (target.kind !== "aris") {
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

  return <ArisPanelContent serverId={serverId} workspaceId={workspaceId} target={target} />;
}

function ArisPanelContent({
  serverId,
  workspaceId,
  target,
}: {
  serverId: string;
  workspaceId: string;
  target: { kind: "aris"; runId?: string; view?: "cockpit" | "graph" | "review" };
}) {
  const reviewQuery = useArisReviewQuery({
    serverId,
    workspaceId,
    runId: target.runId,
  });
  const eventsQuery = useArisEventsQuery({
    serverId,
    workspaceId,
    runId: target.runId,
  });
  const runsQuery = useArisRunsQuery({ serverId, workspaceId });
  const runQuery = useArisRunQuery({
    serverId,
    workspaceId,
    runId: target.runId ?? null,
  });
  const iterationsQuery = useArisIterationsQuery({
    serverId,
    workspaceId,
    runId: target.runId ?? null,
  });

  if (
    reviewQuery.isLoading ||
    eventsQuery.isLoading ||
    runsQuery.isLoading ||
    runQuery.isLoading ||
    iterationsQuery.isLoading
  ) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }

  const error =
    reviewQuery.error ??
    eventsQuery.error ??
    runsQuery.error ??
    runQuery.error ??
    iterationsQuery.error;
  if (error) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
        <Text style={{ textAlign: "center", color: "#ef4444" }}>{String(error)}</Text>
      </View>
    );
  }

  return (
    <ArisCockpitView
      review={reviewQuery.data ?? null}
      events={eventsQuery.data ?? null}
      runs={runsQuery.runs}
      run={runQuery.run}
      iterations={iterationsQuery.iterations}
      activeView={target.view ?? "cockpit"}
    />
  );
}

export const arisPanelRegistration: PanelRegistration<"aris"> = {
  kind: "aris",
  component: ArisPanel,
  useDescriptor: useArisPanelDescriptor,
};
