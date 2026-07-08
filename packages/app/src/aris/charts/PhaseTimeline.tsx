import { View, Text } from "react-native";

const placeholderStyle = {
  flex: 1,
  alignItems: "center" as const,
  justifyContent: "center" as const,
};

export function ArisPhaseTimeline() {
  return (
    <View style={placeholderStyle}>
      <Text>Phase timeline is not available on this platform</Text>
    </View>
  );
}
