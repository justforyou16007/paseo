import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import invariant from "tiny-invariant";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Lightbulb } from "lucide-react-native";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { isNative } from "@/constants/platform";
import IdeasView from "@/aris/views/IdeasView";
import ExperimentsView from "@/aris/views/ExperimentsView";

function useArisPanelDescriptor(): PanelDescriptor {
  return {
    label: "ARIS",
    subtitle: "Research insights",
    titleState: "ready",
    icon: Lightbulb,
    statusBucket: null,
  };
}

type ArisTab = "ideas" | "experiments";

function ArisPanel() {
  const { target } = usePaneContext();
  invariant(target.kind === "aris", "ArisPanel requires aris target");
  const [activeTab, setActiveTab] = useState<ArisTab>("ideas");
  const showIdeas = useCallback(() => setActiveTab("ideas"), []);
  const showExperiments = useCallback(() => setActiveTab("experiments"), []);

  if (isNative) {
    return (
      <View style={styles.nativePlaceholder}>
        <ThemedActivityIndicator size="large" uniProps={mutedColorMapping} />
        <Text style={styles.nativeText}>ARIS visualization is only available on web.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.tabBar}>
        <TabButton active={activeTab === "ideas"} label="Ideas" onPress={showIdeas} />
        <TabButton
          active={activeTab === "experiments"}
          label="Experiments"
          onPress={showExperiments}
        />
      </View>

      <View style={styles.content}>
        {activeTab === "ideas" ? <IdeasView /> : <ExperimentsView />}
      </View>
    </View>
  );
}

function TabButton({
  active,
  label,
  onPress,
}: {
  active: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={getTabButtonStyle(active)}>
      <Text style={active ? styles.tabLabelActive : styles.tabLabel}>{label}</Text>
    </Pressable>
  );
}

function getTabButtonStyle(active: boolean) {
  return ({ pressed }: { pressed: boolean }) => [
    styles.tabButton,
    active && styles.tabButtonActive,
    pressed && styles.tabButtonPressed,
  ];
}

const ThemedActivityIndicator = withUnistyles(ActivityIndicator);

const mutedColorMapping = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  tabBar: {
    flexDirection: "row",
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[2],
  },
  tabButton: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[2],
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabButtonActive: {
    borderBottomColor: theme.colors.foreground,
  },
  tabButtonPressed: {
    opacity: 0.7,
  },
  tabLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  tabLabelActive: {
    color: theme.colors.foreground,
    fontWeight: "600",
  },
  content: {
    flex: 1,
    minHeight: 0,
  },
  nativePlaceholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
  },
  nativeText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));

export const arisPanelRegistration: PanelRegistration<"aris"> = {
  kind: "aris",
  component: ArisPanel,
  useDescriptor: useArisPanelDescriptor,
};
