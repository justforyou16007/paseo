import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export default function IdeasView() {
  return (
    <View style={styles.container}>
      <Text style={styles.text}>ARIS idea visualization is only available on web.</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface0,
    padding: theme.spacing[4],
  },
  text: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
