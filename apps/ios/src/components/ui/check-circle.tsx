import { Pressable, StyleSheet, View } from "react-native";
import { IconCheck } from "@/components/icons.ts";
import { colors, radius, space } from "@/theme/tokens.ts";

/** The circle's width: a row lines its title up past it. */
export const checkCircleSize = space(5.5);

/**
 * A to-do's checkbox, as Reminders draws one: an empty ring, filled with a check once done, on a
 * 44pt target. `label` is what VoiceOver reads, the action it takes.
 */
export function CheckCircle(props: {
  isSelected: boolean;
  label: string;
  onChange: (selected: boolean) => void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={props.label}
      accessibilityState={{ checked: props.isSelected }}
      hitSlop={space(3)}
      onPress={() => props.onChange(!props.isSelected)}
      style={({ pressed }) => [styles.target, pressed && styles.pressed]}
    >
      <View style={[styles.ring, props.isSelected && styles.on]}>
        {props.isSelected ? <IconCheck size={space(3.5)} color={colors.primaryForeground} /> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  target: { alignItems: "center", justifyContent: "center" },
  ring: {
    width: checkCircleSize,
    height: checkCircleSize,
    borderRadius: radius.full,
    borderWidth: 1.5,
    borderColor: colors.hairlineLine,
    alignItems: "center",
    justifyContent: "center",
  },
  on: { backgroundColor: colors.primary, borderColor: colors.primary },
  pressed: { transform: [{ scale: 0.92 }] },
});
