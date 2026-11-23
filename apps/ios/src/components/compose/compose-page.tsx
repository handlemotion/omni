import { Stack } from "expo-router";
import { useEffect, useState, type ReactNode } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { IconArrowUp, IconChevronLeft } from "@/components/icons.ts";
import { FloatingButton } from "@/components/ui/floating.tsx";
import { colors, iconSize, space } from "@/theme/tokens.ts";

function useKeyboardShown() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const ios = Platform.OS === "ios";
    const show = Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", () =>
      setShown(true),
    );
    const hide = Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", () =>
      setShown(false),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return shown;
}

/**
 * The composer as a page, like a conversation: a header row (a round Back, `from` in the middle,
 * a round blue Send), the fields scrolling under it, and `toolbar` riding on the keyboard over a
 * hairline. While `dirty`, the page won't swipe back; Back asks before throwing the draft away.
 */
export function ComposePage(props: {
  dirty: boolean;
  from: ReactNode;
  canSend: boolean;
  isSending: boolean;
  onSend: () => void;
  onClose: () => void;
  toolbar: ReactNode;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardShown();
  return (
    <KeyboardAvoidingView
      style={styles.page}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Stack.Screen options={{ gestureEnabled: !props.dirty }} />
      <View style={[styles.header, { paddingTop: insets.top + space(2) }]}>
        <FloatingButton
          icon={IconChevronLeft}
          label="Back"
          compact
          glyph={iconSize.field}
          onPress={props.onClose}
        />
        <View style={styles.from}>{props.from}</View>
        <FloatingButton
          icon={IconArrowUp}
          label="Send"
          compact
          primary
          glyph={iconSize.field}
          disabled={!props.canSend}
          isPending={props.isSending}
          onPress={props.onSend}
        />
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerStyle={styles.content}
        style={styles.page}
      >
        {props.children}
      </ScrollView>
      <View
        style={[styles.toolbar, { paddingBottom: keyboard ? space(2) : insets.bottom + space(2) }]}
      >
        {props.toolbar}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    paddingHorizontal: space(4),
    paddingVertical: space(2),
  },
  from: { flex: 1, minWidth: 0, alignItems: "center" },
  content: { flexGrow: 1 },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(1),
    paddingHorizontal: space(2.5),
    paddingTop: space(2),
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
});
