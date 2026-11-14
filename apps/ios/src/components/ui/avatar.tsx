import { StyleSheet, View } from "react-native";
import { colors, radius } from "@/theme/tokens.ts";
import { Text } from "./text.tsx";

/** A round initial on the accent fill, as the web's avatars draw a person with no picture. */
export function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <View accessible={false} style={[styles.avatar, { width: size, height: size }]}>
      <Text size={size >= 40 ? "lg" : "sm"} weight="medium">
        {initial}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: {
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
});
