import { BottomSheet as SwiftUISheet, Group, Host, RNHostView } from "@expo/ui/swift-ui";
import { presentationDragIndicator } from "@expo/ui/swift-ui/modifiers";
import { useRef, useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { space } from "@/theme/tokens.ts";
import { Text } from "./text.tsx";

const MAX_SHARE = 0.8;
const PRESENTATION = [presentationDragIndicator("visible")];

/**
 * A sheet's (or a popover's) open state, and `pick(then)` for its rows: close it and run `then`
 * once it has gone (`onClosed`). Both are native modals: a row that navigates, closes the menu
 * holding the sheet, or presents another view controller (a picker, a prompt) while one is still
 * up or on its way out makes UIKit and the native stack disagree with React about what is on
 * screen, and the shell vanishes until something later sets it right.
 */
export function useSheet() {
  const [isOpen, setOpen] = useState(false);
  const after = useRef<(() => void) | null>(null);
  return {
    isOpen,
    open: () => setOpen(true),
    close: () => setOpen(false),
    pick: (then: () => void) => {
      after.current = then;
      setOpen(false);
    },
    onClosed: () => {
      const then = after.current;
      after.current = null;
      then?.();
    },
  };
}

/**
 * The system sheet (SwiftUI's), sized to its content: a grabber, its title, then its rows. It
 * floats and rounds as iOS draws it; dragging it down or tapping above it closes it.
 */
export function BottomSheet({
  isOpen,
  onClose,
  onClosed,
  title,
  header,
  children,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** Once the sheet has gone: where to open what a row picked, so it is not under the sheet. */
  onClosed?: () => void;
  title: string;
  /** Drawn in place of the title (a file's tile, name and size); `title` still names the sheet. */
  header?: ReactNode;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  return (
    <Host style={styles.host} pointerEvents="none">
      <SwiftUISheet
        isPresented={isOpen}
        onIsPresentedChange={(presented) => {
          if (!presented) onClose();
        }}
        onDismiss={onClosed}
        fitToContents
      >
        <Group modifiers={PRESENTATION}>
          <RNHostView matchContents={{ vertical: true }}>
            <View
              accessibilityViewIsModal
              style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, space(6)) }]}
            >
              {header ?? (
                <View style={styles.title}>
                  <Text weight="semibold" accessibilityRole="header" numberOfLines={1}>
                    {title}
                  </Text>
                </View>
              )}
              <ScrollView style={{ maxHeight: height * MAX_SHARE }}>{children}</ScrollView>
            </View>
          </RNHostView>
        </Group>
      </SwiftUISheet>
    </Host>
  );
}

const styles = StyleSheet.create({
  host: { position: "absolute" },
  sheet: { paddingTop: space(5), paddingHorizontal: space(1.5) },
  title: { height: space(11), justifyContent: "center", paddingHorizontal: space(3.5) },
});
