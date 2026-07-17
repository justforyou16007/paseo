/* eslint-disable jsx-no-new-object-as-prop -- ARIS panel uses inline styles for rapid prototyping */
import { ActivityIndicator, Text, View } from "react-native";
import { Network, FlaskConical, Microscope } from "lucide-react-native";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { usePaneContext } from "@/panels/pane-context";
import { isWeb } from "@/constants/platform";
import { useArisReviewQuery } from "@/aris/use-aris-review-query";
import { useArisEventsQuery } from "@/aris/use-aris-events-query";
import { useArisWiki } from "@/aris/use-aris-wiki";
import { useArisRunsQuery, useArisRunQuery, useArisIterationsQuery } from "@/hooks/use-aris-query";
import { useWorkspace } from "@/stores/session-store-hooks";
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
  const workspace = useWorkspace(serverId, workspaceId);
  const cwd = workspace?.workspaceDirectory ?? null;
  const wikiQuery = useArisWiki(serverId, cwd);

  // Render with whatever data is available. Each child view is responsible
  // for handling its own loading/error state — the panel-level spinner was
  // the source of the perpetual "always loading" bug because any single
  // disabled query would keep the whole panel stuck on the spinner.
  // We only show a panel-level spinner when NO query has started yet
  // (workspaceId is empty or client isn't connected at all).
  const hasAnyWorkspace = !!workspaceId;
  const noDataYet =
    !reviewQuery.data && !eventsQuery.data && !wikiQuery.data && runsQuery.runs.length === 0;

  if (!hasAnyWorkspace) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
        <Text style={{ textAlign: "center", color: "#64748b" }}>
          Open the ARIS Cockpit from a specific workspace to see W1–W6 status and the knowledge
          graph.
        </Text>
      </View>
    );
  }

  if (
    noDataYet &&
    (reviewQuery.isLoading || eventsQuery.isLoading || runsQuery.isLoading || wikiQuery.isLoading)
  ) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
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
      wiki={wikiQuery.data}
      activeView={target.view ?? "cockpit"}
    />
  );
}

export const arisPanelRegistration: PanelRegistration<"aris"> = {
  kind: "aris",
  component: ArisPanel,
  useDescriptor: useArisPanelDescriptor,
};
