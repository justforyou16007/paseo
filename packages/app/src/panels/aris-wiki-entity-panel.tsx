/* eslint-disable jsx-no-new-object-as-prop -- ARIS panel uses inline styles for rapid prototyping */
import { useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { BookOpen, Lightbulb, FlaskConical, CheckCircle2, Crosshair } from "lucide-react-native";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { usePaneContext } from "@/panels/pane-context";
import { isWeb } from "@/constants/platform";
import { useWorkspace } from "@/stores/session-store-hooks";
import { useArisWikiEntity, type ArisWikiEntityType } from "@/aris/use-aris-wiki-entity";
import { ARIS_KNOWLEDGE_GRAPH_NODE_COLORS } from "@/aris/charts/color-palette";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { Theme } from "@/styles/theme";

const ENTITY_TYPE_LABELS: Record<ArisWikiEntityType, string> = {
  papers: "Paper",
  ideas: "Idea",
  experiments: "Experiment",
  claims: "Claim",
  gap: "Gap map",
};

const ENTITY_TYPE_ICONS: Record<ArisWikiEntityType, typeof BookOpen> = {
  papers: BookOpen,
  ideas: Lightbulb,
  experiments: FlaskConical,
  claims: CheckCircle2,
  gap: Crosshair,
};

const ENTITY_TYPE_COLOR: Record<ArisWikiEntityType, string> = {
  papers: ARIS_KNOWLEDGE_GRAPH_NODE_COLORS.paper,
  ideas: ARIS_KNOWLEDGE_GRAPH_NODE_COLORS.idea,
  experiments: ARIS_KNOWLEDGE_GRAPH_NODE_COLORS.experiment,
  claims: ARIS_KNOWLEDGE_GRAPH_NODE_COLORS.claim,
  gap: ARIS_KNOWLEDGE_GRAPH_NODE_COLORS.gap,
};

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function useArisWikiEntityPanelDescriptor(target: {
  kind: "aris-wiki-entity";
  entityType: ArisWikiEntityType;
  entityId: string;
}): PanelDescriptor {
  const label = `${ENTITY_TYPE_LABELS[target.entityType]} · ${target.entityId}`;
  return {
    label,
    subtitle: `ARIS wiki · ${label}`,
    titleState: "ready",
    icon: BookOpen,
    statusBucket: null,
  };
}

function ArisWikiEntityPanel() {
  const { serverId, workspaceId, target } = usePaneContext();
  if (target.kind !== "aris-wiki-entity") {
    return null;
  }

  if (!isWeb) {
    return (
      <View style={styles.centerBox}>
        <Text style={styles.mutedText}>ARIS visualization is only available on web.</Text>
      </View>
    );
  }

  return (
    <ArisWikiEntityPanelContent
      serverId={serverId}
      workspaceId={workspaceId}
      entityType={target.entityType}
      entityId={target.entityId}
    />
  );
}

function ArisWikiEntityPanelContent({
  serverId,
  workspaceId,
  entityType,
  entityId,
}: {
  serverId: string;
  workspaceId: string;
  entityType: ArisWikiEntityType;
  entityId: string;
}) {
  const workspace = useWorkspace(serverId, workspaceId);
  const cwd = workspace?.workspaceDirectory ?? null;
  const { data, isLoading, isError, error } = useArisWikiEntity(
    serverId,
    cwd,
    entityType,
    entityId,
  );

  const Icon = ENTITY_TYPE_ICONS[entityType];
  const color = ENTITY_TYPE_COLOR[entityType];
  const iconBadgeStyle = useMemo(
    () => [styles.iconBadge, { backgroundColor: `${color}1a`, borderColor: color }],
    [color],
  );
  const typeChipStyle = useMemo(() => [styles.typeChip, { borderColor: color }], [color]);
  const typeDotStyle = useMemo(() => [styles.typeDot, { backgroundColor: color }], [color]);
  const typeChipTextStyle = useMemo(() => [styles.typeChipText, { color }], [color]);

  if (isLoading) {
    return (
      <View style={styles.centerBox}>
        <ThemedLoadingSpinner uniProps={foregroundMutedColorMapping} />
      </View>
    );
  }

  if (isError) {
    return (
      <View style={styles.centerBox}>
        <Text style={styles.errorText}>{error?.message ?? "..."}</Text>
      </View>
    );
  }

  if (!data) {
    return (
      <View style={styles.centerBox}>
        <Text style={styles.mutedText}>
          {ENTITY_TYPE_LABELS[entityType]} {entityId} not found.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerBar}>
          <View style={iconBadgeStyle}>
            <Icon size={16} color={color} strokeWidth={2} />
          </View>
          <View style={styles.headerText}>
            <View style={typeChipStyle}>
              <View style={typeDotStyle} />
              <Text style={typeChipTextStyle}>{ENTITY_TYPE_LABELS[entityType]}</Text>
            </View>
            <Text style={styles.entityId}>{entityId}</Text>
          </View>
        </View>
        <View style={styles.contentBox}>
          <Text selectable style={styles.contentText}>
            {data.content}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  content: {
    padding: theme.spacing[4],
    gap: theme.spacing[4],
  },
  centerBox: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
  },
  mutedText: {
    textAlign: "center",
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  errorText: {
    textAlign: "center",
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusDanger,
  },
  headerBar: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  iconBadge: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    alignItems: "center",
    justifyContent: "center",
  },
  headerText: {
    flex: 1,
    gap: theme.spacing[1.5],
  },
  typeChip: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    borderWidth: theme.borderWidth[1],
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
  },
  typeDot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
  },
  typeChipText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  entityId: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  contentBox: {
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[4],
  },
  contentText: {
    color: theme.colors.foreground,
    fontFamily: "monospace",
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
}));

export const arisWikiEntityPanelRegistration: PanelRegistration<"aris-wiki-entity"> = {
  kind: "aris-wiki-entity",
  component: ArisWikiEntityPanel,
  useDescriptor: useArisWikiEntityPanelDescriptor,
};
