import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export default function ExperimentsView() {
  return (
    <View style={styles.container}>
      <Text style={styles.text}>ARIS experiments are only available on web.</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  text: {
    color: theme.colors.foregroundMuted,
  },
}));
