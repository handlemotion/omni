import type { ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, radius, space } from "@/theme/tokens.ts";
import { Text } from "./text.tsx";

/**
 * A sheet that slides up from the bottom edge over the dimmed page: a grabber, its title, then
 * its rows. A tap above it closes it.
 */
export function BottomSheet({
  isOpen,
  onClose,
  title,
  children,
}: {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal transparent visible={isOpen} animationType="slide" onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Close ${title}`}
        onPress={onClose}
        style={styles.scrim}
      />
      <View
        accessibilityViewIsModal
        style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, space(10)) }]}
      >
        <View style={styles.grabber} />
        <View style={styles.title}>
          <Text weight="semibold" accessibilityRole="header">
            {title}
          </Text>
        </View>
        <ScrollView>{children}</ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: "80%",
    paddingTop: space(2),
    paddingHorizontal: space(1.5),
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    backgroundColor: colors.background,
  },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: colors.scrim },
  grabber: {
    alignSelf: "center",
    width: space(9),
    height: space(1.25),
    marginBottom: space(2),
    borderRadius: radius.full,
    backgroundColor: colors.hairlineLine,
  },
  title: { height: space(11), justifyContent: "center", paddingHorizontal: space(3.5) },
});
