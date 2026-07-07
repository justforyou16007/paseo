/* eslint-disable jsx-no-new-object-as-prop -- ARIS visualization views use inline styles for rapid prototyping */
import React from "react";
import { View, Text, ScrollView } from "react-native";
import type { ArisReviewReadResult } from "./use-aris-review-query";
import type { ArisEventsReadResult } from "./use-aris-events-query";
import { ReviewView } from "./ReviewView.web";
import { KnowledgeGraphView } from "./KnowledgeGraphView.web";
import { ChartKitEmpty } from "./chart-kit";

export interface ArisCockpitViewProps {
  review: ArisReviewReadResult | null | undefined;
  events: ArisEventsReadResult | null | undefined;
  activeView?: "cockpit" | "graph" | "review";
}

export function ArisCockpitView({ review, events, activeView = "cockpit" }: ArisCockpitViewProps) {
  if (activeView === "graph") {
    return <KnowledgeGraphView data={review} />;
  }
  if (activeView === "review") {
    return <ReviewView data={review} />;
  }

  return <ArisCockpitBody review={review} events={events} />;
}

function ArisCockpitBody({
  review,
  events,
}: {
  review: ArisReviewReadResult | null | undefined;
  events: ArisEventsReadResult | null | undefined;
}) {
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 24 }}>
      <CockpitHeader />
      <PipelineMetrics review={review} events={events} />
      <KnowledgeGraphPreview review={review} />
      <ReviewSummary review={review} />
    </ScrollView>
  );
}

function CockpitHeader() {
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontSize: 22, fontWeight: "700" }}>ARIS Cockpit</Text>
      <Text style={{ fontSize: 14, color: "#64748b" }}>
        Integrated research pipeline, review, and knowledge graph.
      </Text>
    </View>
  );
}

function PipelineMetrics({
  review,
  events,
}: {
  review: ArisReviewReadResult | null | undefined;
  events: ArisEventsReadResult | null | undefined;
}) {
  return (
    <View style={{ gap: 12 }}>
      <Text style={{ fontSize: 16, fontWeight: "600" }}>Pipeline Status</Text>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <MetricCard label="Review Stage" value={review?.reviewState?.stage ?? "—"} />
        <MetricCard label="Rounds" value={`${review?.reviewState?.rounds?.length ?? 0}`} />
        <MetricCard label="Audits" value={`${review?.audits.length ?? 0}`} />
        <MetricCard label="Pending Items" value={`${review?.pendingReview?.items?.length ?? 0}`} />
        <MetricCard label="Graph Edges" value={`${review?.knowledgeGraph?.edges?.length ?? 0}`} />
        <MetricCard label="Recent Events" value={`${events?.events.length ?? 0}`} />
      </View>
    </View>
  );
}

function KnowledgeGraphPreview({ review }: { review: ArisReviewReadResult | null | undefined }) {
  return (
    <View style={{ gap: 12 }}>
      <Text style={{ fontSize: 16, fontWeight: "600" }}>Knowledge Graph Preview</Text>
      <KnowledgeGraphView data={review} width={640} height={240} />
    </View>
  );
}

function ReviewSummary({ review }: { review: ArisReviewReadResult | null | undefined }) {
  return (
    <View style={{ gap: 12 }}>
      <Text style={{ fontSize: 16, fontWeight: "600" }}>Review Summary</Text>
      {review?.reviewState ? (
        <ReviewView data={review} />
      ) : (
        <ChartKitEmpty message="No review summary available." />
      )}
    </View>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <View
      style={{
        minWidth: 120,
        padding: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: "#e2e8f0",
        backgroundColor: "#f8fafc",
      }}
    >
      <Text style={{ fontSize: 12, color: "#64748b" }}>{label}</Text>
      <Text style={{ fontSize: 18, fontWeight: "700", marginTop: 4 }}>{value}</Text>
    </View>
  );
}
