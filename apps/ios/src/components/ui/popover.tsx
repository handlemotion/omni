import type { ReactNode } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";

/**
 * Content floating over the page at a fixed spot (above the button that opened it), closed by a
 * tap anywhere else. Flat: the content draws its own edge. Open what a row picks in `onClosed`
 * (`useSheet().pick`), once it has faded out, never while it is still up.
 */
export function Popover({
  isOpen,
  onClose,
  onClosed,
  label,
  at,
  children,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** Once it has gone: where to open what a row picked, so it is not under the popover. */
  onClosed?: () => void;
  /** What VoiceOver reads for the area around it. */
  label: string;
  /** Where it sits, from the screen's edges. */
  at: { top?: number; right?: number; bottom?: number; left?: number };
  children: ReactNode;
}) {
  return (
    <Modal
      transparent
      visible={isOpen}
      animationType="fade"
      onRequestClose={onClose}
      onDismiss={onClosed}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onClose}
        style={StyleSheet.absoluteFill}
      />
      <View accessibilityViewIsModal style={[styles.content, at]}>
        {children}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({ content: { position: "absolute", minWidth: 200 } });
