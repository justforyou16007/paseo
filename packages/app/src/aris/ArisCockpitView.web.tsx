/* eslint-disable jsx-no-new-object-as-prop -- ARIS visualization views use inline styles for rapid prototyping */
import React from "react";
import { View, Text, ScrollView } from "react-native";
import type { ArisRunState, ArisIteration } from "@getpaseo/protocol/messages";
import type { ArisReviewReadResult } from "./use-aris-review-query";
import type { ArisEventsReadResult } from "./use-aris-events-query";
import { ReviewView } from "./ReviewView.web";
import { KnowledgeGraphView } from "./KnowledgeGraphView.web";
import { PipelineView } from "./views/PipelineView.web";
import { IterationsView } from "./views/IterationsView.web";
import { ChartKitEmpty } from "./chart-kit";

export interface ArisCockpitViewProps {
  review: ArisReviewReadResult | null | undefined;
  events: ArisEventsReadResult | null | undefined;
  runs: ArisRunState[];
  run: ArisRunState | null;
  iterations: ArisIteration[];
  activeView?: "cockpit" | "graph" | "review";
}

export function ArisCockpitView({
  review,
  events,
  runs,
  run,
  iterations,
  activeView = "cockpit",
}: ArisCockpitViewProps) {
  if (activeView === "graph") {
    return <KnowledgeGraphView data={review} />;
  }
  if (activeView === "review") {
    return <ReviewView data={review} />;
  }

  return (
    <ArisCockpitBody
      review={review}
      events={events}
      runs={runs}
      run={run}
      iterations={iterations}
    />
  );
}

function renderRunContent(
  runs: ArisRunState[],
  run: ArisRunState | null,
  iterations: ArisIteration[],
) {
  if (run) {
    return (
      <>
        <PipelineView run={run} width={640} />
        <IterationsView iterations={iterations} runId={run.runId} width={640} />
      </>
    );
  }
  if (runs.length > 0) {
    return <RunList runs={runs} />;
  }
  return null;
}

function ArisCockpitBody({
  review,
  events,
  runs,
  run,
  iterations,
}: {
  review: ArisReviewReadResult | null | undefined;
  events: ArisEventsReadResult | null | undefined;
  runs: ArisRunState[];
  run: ArisRunState | null;
  iterations: ArisIteration[];
}) {
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 24 }}>
      <CockpitHeader />
      <PipelineMetrics
        review={review}
        events={events}
        runs={runs}
        run={run}
        iterations={iterations}
      />
      {renderRunContent(runs, run, iterations)}
      <KnowledgeGraphPreview review={review} />
      <ReviewSummary review={review} />
    </ScrollView>
  );
}

function RunList({ runs }: { runs: ArisRunState[] }) {
  return (
    <View style={{ gap: 12 }}>
      <Text style={{ fontSize: 16, fontWeight: "600" }}>Available Runs ({runs.length})</Text>
      {runs.map((run) => (
        <View
          key={run.runId}
          style={{
            padding: 12,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: "#e2e8f0",
            backgroundColor: "#f8fafc",
          }}
        >
          <Text style={{ fontSize: 14, fontWeight: "600" }}>
            {run.goal || `Run ${run.runId.slice(0, 8)}`}
          </Text>
          <Text style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>
            {run.status} — {run.phases.length} phases —{" "}
            {run.createdAt ? new Date(run.createdAt).toLocaleDateString() : ""}
          </Text>
        </View>
      ))}
    </View>
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

// eslint-disable-next-line complexity
function PipelineMetrics({
  review,
  events,
  runs,
  run,
  iterations,
}: {
  review: ArisReviewReadResult | null | undefined;
  events: ArisEventsReadResult | null | undefined;
  runs: ArisRunState[];
  run: ArisRunState | null;
  iterations: ArisIteration[];
}) {
  const runStatus = run?.status ?? "—";
  const phaseCount = run?.phases.length ?? 0;
  const reviewStage = review?.reviewState?.stage ?? "—";
  const roundCount = review?.reviewState?.rounds?.length ?? 0;
  const auditCount = review?.audits.length ?? 0;
  const pendingCount = review?.pendingReview?.items?.length ?? 0;
  const edgeCount = review?.knowledgeGraph?.edges?.length ?? 0;
  const eventCount = events?.events.length ?? 0;

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
        <MetricCard label="Runs" value={`${runs.length}`} />
        <MetricCard label="Run Status" value={runStatus} />
        <MetricCard label="Iterations" value={`${iterations.length}`} />
        <MetricCard label="Phases" value={`${phaseCount}`} />
        <MetricCard label="Review Stage" value={reviewStage} />
        <MetricCard label="Rounds" value={`${roundCount}`} />
        <MetricCard label="Audits" value={`${auditCount}`} />
        <MetricCard label="Pending Items" value={`${pendingCount}`} />
        <MetricCard label="Graph Edges" value={`${edgeCount}`} />
        <MetricCard label="Recent Events" value={`${eventCount}`} />
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
