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
import { IconArrowUp, IconX } from "@/components/icons.ts";
import { FloatingButton } from "@/components/ui/floating.tsx";
import { colors, iconSize, radius, space } from "@/theme/tokens.ts";

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
 * The composer's sheet: a grabber, a header row (a round Close, `from` in the middle, a round
 * blue Send), the fields scrolling under it, and `toolbar` riding on the keyboard over a hairline.
 * While `dirty`, the sheet won't swipe away.
 */
export function ComposeSheet(props: {
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
      style={styles.sheet}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={insets.top}
    >
      <Stack.Screen options={{ gestureEnabled: !props.dirty }} />
      <View style={styles.grabber} />
      <View style={styles.header}>
        <FloatingButton
          icon={IconX}
          label="Close"
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
        style={styles.sheet}
      >
        {props.children}
      </ScrollView>
      <View style={[styles.toolbar, { paddingBottom: keyboard ? space(2) : insets.bottom }]}>
        {props.toolbar}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.background },
  grabber: {
    alignSelf: "center",
    width: space(9),
    height: space(1.25),
    marginTop: space(2),
    borderRadius: radius.full,
    backgroundColor: colors.hairlineLine,
  },
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
