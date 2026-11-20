import { Pressable, StyleSheet, View } from "react-native";
import { colors, radius, space } from "@/theme/tokens.ts";
import { Text } from "./text.tsx";

/**
 * A row of views over a list, one on at a time (the web's toggle group): flat pills, the one
 * that's on filled with the accent, each with its count when it has one.
 */
export function Segmented<K extends string>(props: {
  options: { id: K; label: string; count?: number | null }[];
  value: K;
  onChange: (id: K) => void;
}) {
  return (
    <View accessibilityRole="tablist" style={styles.row}>
      {props.options.map((option) => {
        const on = option.id === props.value;
        return (
          <Pressable
            key={option.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => props.onChange(option.id)}
            style={({ pressed }) => [styles.pill, on && styles.on, pressed && styles.pressed]}
          >
            <Text size="subhead" weight="medium" tone={on ? "foreground" : "mutedForeground"}>
              {option.label}
            </Text>
            {option.count ? (
              <Text size="caption" tone="mutedForeground" tabular>
                {option.count}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", gap: space(1) },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(1.5),
    height: space(8),
    paddingHorizontal: space(3),
    borderRadius: radius.full,
  },
  on: { backgroundColor: colors.accent },
  pressed: { transform: [{ scale: 0.97 }] },
});
