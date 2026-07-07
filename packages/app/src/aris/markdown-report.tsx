/* eslint-disable jsx-no-new-object-as-prop -- ARIS visualization views use inline styles for rapid prototyping */
import React from "react";
import { View, Text } from "react-native";

export interface MarkdownReportProps {
  content: string | null | undefined;
}

export function MarkdownReport({ content }: MarkdownReportProps) {
  if (!content) {
    return (
      <View style={{ padding: 16 }}>
        <Text style={{ color: "#64748b" }}>No report content available.</Text>
      </View>
    );
  }

  return (
    <View style={{ padding: 16 }}>
      <Text style={{ fontFamily: "monospace", fontSize: 13, lineHeight: 20, color: "#334155" }}>
        {content}
      </Text>
    </View>
  );
}
