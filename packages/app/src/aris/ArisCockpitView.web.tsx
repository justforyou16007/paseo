/* eslint-disable jsx-no-new-object-as-prop -- ARIS visualization views use inline styles for rapid prototyping */
import { ScrollView, Text, View } from "react-native";
import type { ArisIteration, ArisRunState } from "@getpaseo/protocol/messages";
import type { ArisReviewReadResult } from "./use-aris-review-query";
import type { ArisEventsReadResult } from "./use-aris-events-query";
import { ReviewView } from "./ReviewView.web";
import { KnowledgeGraphView } from "./KnowledgeGraphView.web";
import { WorkflowGraphView } from "./views/WorkflowGraphView.web";

export interface ArisCockpitViewProps {
  review: ArisReviewReadResult | null | undefined;
  events: ArisEventsReadResult | null | undefined;
  runs: ArisRunState[];
  run: ArisRunState | null;
  iterations: ArisIteration[];
  activeView?: "cockpit" | "graph" | "review";
}

export function ArisCockpitView({ review, activeView = "cockpit" }: ArisCockpitViewProps) {
  if (activeView === "graph") {
    return <KnowledgeGraphView data={review} />;
  }
  if (activeView === "review") {
    return <ReviewView data={review} />;
  }

  return <ArisCockpitBody review={review} />;
}

function ArisCockpitBody({ review }: { review: ArisReviewReadResult | null | undefined }) {
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 24 }}>
      <CockpitHeader />
      <WorkflowGraphView />
      <KnowledgeGraphSection review={review} />
    </ScrollView>
  );
}

function CockpitHeader() {
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontSize: 22, fontWeight: "700" }}>ARIS Cockpit</Text>
      <Text style={{ fontSize: 14, color: "#64748b" }}>
        W1–W6 workflow status and research knowledge graph.
      </Text>
    </View>
  );
}

function KnowledgeGraphSection({ review }: { review: ArisReviewReadResult | null | undefined }) {
  return (
    <View style={{ gap: 12 }}>
      <Text style={{ fontSize: 16, fontWeight: "600" }}>Knowledge Graph</Text>
      <KnowledgeGraphView data={review} />
    </View>
  );
}
