import { Pressable, StyleSheet } from "react-native";
import type { LogoFor } from "@/lib/sender-logo.ts";
import { space } from "@/theme/tokens.ts";
import { Avatar } from "./avatar.tsx";
import { Text } from "./text.tsx";

/**
 * A person as a tile you can press: their squarish avatar over their name in one short line,
 * `width` wide (search's People). Squeezes to 0.97 while pressed.
 */
export function AvatarTile({
  name,
  logo,
  size,
  width,
  label,
  onPress,
}: {
  name: string;
  logo?: LogoFor | null;
  size: number;
  width: number;
  /** What VoiceOver reads: name the action. */
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.tile, { width }, pressed && styles.pressed]}
    >
      <Avatar name={name} logo={logo} size={size} shape="square" />
      <Text size="caption" numberOfLines={1} style={{ maxWidth: width }}>
        {name}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: { alignItems: "center", gap: space(1.5) },
  pressed: { transform: [{ scale: 0.97 }] },
});
