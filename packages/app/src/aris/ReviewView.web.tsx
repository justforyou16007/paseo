/* eslint-disable jsx-no-new-object-as-prop -- ARIS visualization views use inline styles for rapid prototyping */
import React, { useMemo } from "react";
import { View, Text, ScrollView } from "react-native";
import type { ArisReviewReadResult } from "./use-aris-review-query";
import { ChartKitBar, ChartKitEmpty } from "./chart-kit";
import { MarkdownReport } from "./markdown-report";

export interface ReviewViewProps {
  data: ArisReviewReadResult | null | undefined;
}

const VERDICT_COLORS: Record<string, string> = {
  pass: "#10b981",
  fail: "#ef4444",
  warning: "#f59e0b",
  na: "#94a3b8",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "#94a3b8",
  active: "#3b82f6",
  completed: "#10b981",
  rejected: "#ef4444",
};

export function ReviewView({ data }: ReviewViewProps) {
  const verdictChartData = useMemo(() => {
    const counts: Record<string, number> = { pass: 0, fail: 0, warning: 0, na: 0 };
    for (const audit of data?.audits ?? []) {
      for (const verdict of audit.verdicts ?? []) {
        counts[verdict.verdict] = (counts[verdict.verdict] ?? 0) + 1;
      }
    }
    return Object.entries(counts)
      .filter(([, value]) => value > 0)
      .map(([label, value]) => ({
        label,
        value,
        color: VERDICT_COLORS[label] ?? "#3b82f6",
      }));
  }, [data]);

  if (!data) {
    return <ChartKitEmpty message="No review data available." />;
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 24 }}>
      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 20, fontWeight: "600" }}>Review Rounds</Text>
        <Text style={{ fontSize: 14, color: "#64748b" }}>
          Stage: {data.reviewState?.stage ?? "unknown"} · Verdict:{" "}
          {data.reviewState?.overallVerdict ?? "pending"}
        </Text>
      </View>

      <View style={{ gap: 12 }}>
        {(data.reviewState?.rounds ?? []).map((round) => (
          <View
            key={round.round}
            style={{
              borderRadius: 8,
              padding: 12,
              borderWidth: 1,
              borderColor: "#e2e8f0",
              backgroundColor: "#f8fafc",
            }}
          >
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={{ fontSize: 16, fontWeight: "600" }}>Round {round.round + 1}</Text>
              <Text
                style={{
                  fontSize: 12,
                  fontWeight: "600",
                  color: STATUS_COLORS[round.status] ?? "#64748b",
                }}
              >
                {round.status}
              </Text>
            </View>
            {round.verdict ? (
              <Text style={{ fontSize: 13, color: "#475569", marginTop: 4 }}>{round.verdict}</Text>
            ) : null}
          </View>
        ))}
      </View>

      {verdictChartData.length > 0 ? (
        <View style={{ gap: 8 }}>
          <Text style={{ fontSize: 16, fontWeight: "600" }}>Audit Verdicts</Text>
          <ChartKitBar data={verdictChartData} width={320} height={160} />
        </View>
      ) : null}

      {data.autoReviewMarkdown ? (
        <View style={{ gap: 8 }}>
          <Text style={{ fontSize: 16, fontWeight: "600" }}>Auto Review Report</Text>
          <MarkdownReport content={data.autoReviewMarkdown} />
        </View>
      ) : null}

      <View style={{ gap: 12 }}>
        <Text style={{ fontSize: 16, fontWeight: "600" }}>Audit Files</Text>
        {data.audits.length === 0 ? (
          <Text style={{ fontSize: 13, color: "#64748b" }}>No audit files found.</Text>
        ) : (
          data.audits.map((audit) => (
            <View
              key={audit.fileName}
              style={{
                borderRadius: 8,
                padding: 12,
                borderWidth: 1,
                borderColor: "#e2e8f0",
              }}
            >
              <Text style={{ fontSize: 14, fontWeight: "600" }}>{audit.fileName}</Text>
              {audit.section ? (
                <Text style={{ fontSize: 12, color: "#64748b" }}>Section: {audit.section}</Text>
              ) : null}
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                {(audit.verdicts ?? []).map((verdict) => (
                  <View
                    key={`${audit.fileName}-${verdict.section}`}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 6,
                      paddingHorizontal: 8,
                      paddingVertical: 4,
                      borderRadius: 4,
                      backgroundColor: `${VERDICT_COLORS[verdict.verdict] ?? "#64748b"}20`,
                    }}
                  >
                    <View
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        backgroundColor: VERDICT_COLORS[verdict.verdict] ?? "#64748b",
                      }}
                    />
                    <Text style={{ fontSize: 12, color: "#334155" }}>{verdict.section}</Text>
                  </View>
                ))}
              </View>
            </View>
          ))
        )}
      </View>

      {data.pendingReview?.items && data.pendingReview.items.length > 0 ? (
        <View style={{ gap: 12 }}>
          <Text style={{ fontSize: 16, fontWeight: "600" }}>Pending Review</Text>
          {data.pendingReview.items.map((item) => (
            <View
              key={item.id}
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
                padding: 12,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: "#e2e8f0",
              }}
            >
              <Text style={{ fontSize: 14 }}>{item.title}</Text>
              <Text style={{ fontSize: 12, color: "#64748b" }}>{item.status ?? "pending"}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}
