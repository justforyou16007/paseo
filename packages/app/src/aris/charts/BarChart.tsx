import { View, Text } from "react-native";

const placeholderStyle = {
  flex: 1,
  alignItems: "center" as const,
  justifyContent: "center" as const,
};

export function ArisBarChart() {
  return (
    <View style={placeholderStyle}>
      <Text>Bar chart is not available on this platform</Text>
    </View>
  );
}
