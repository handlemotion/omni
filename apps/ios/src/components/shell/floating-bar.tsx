import { useEffect, useState, type ComponentType } from "react";
import {
  Keyboard,
  LayoutAnimation,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type KeyboardEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { SvgProps } from "react-native-svg";
import { IconMicrophone, IconSearch, IconX } from "@/components/icons.ts";
import { FloatingButton, FloatingField } from "@/components/ui/floating.tsx";
import { TextField } from "@/components/ui/text-field.tsx";
import { useDictation } from "@/lib/dictation.ts";
import { colors, floatingControl, iconSize, space, text } from "@/theme/tokens.ts";

/** How far a list scrolls past its last row, so a bar floating at the bottom never covers it. */
export const FLOATING_BAR_SPACE = floatingControl + space(16);

export interface FloatingBarAction {
  icon: ComponentType<SvgProps & { size?: number }>;
  label: string;
  onPress: () => void;
}

/**
 * A module's open search field, floating above the keyboard (or the home indicator once the
 * keyboard is down), with dictation and a close button.
 */
export function FloatingBar({
  placeholder,
  onSearch,
  onStop,
  initial,
  query,
}: {
  placeholder: string;
  /** What the field starts with, and whether it takes the keyboard (not when coming back to it). */
  initial?: { query: string; focus?: boolean };
  /** What the field shows, when the page under it can fill it (a recent search). */
  query?: string;
  onSearch: (q: string) => void;
  /** The field closed. */
  onStop?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const [q, setQ] = useState(initial?.query ?? "");
  const dictation = useDictation((heard) => {
    setQ(heard);
    onSearch(heard);
  });
  const stop = () => {
    dictation.stop();
    Keyboard.dismiss();
    setQ("");
    onSearch("");
    onStop?.();
  };
  const toggleDictation = () => {
    if (dictation.listening) dictation.stop();
    else void dictation.start();
  };
  const bottom = keyboard ? keyboard + space(2.5) : Math.max(insets.bottom - space(1), space(3));
  return (
    <View pointerEvents="box-none" style={[styles.stack, { paddingBottom: bottom }]}>
      <View pointerEvents="box-none" style={styles.row}>
        <FloatingField icon={IconSearch}>
          <TextField
            label={placeholder}
            placeholder={placeholder}
            variant="bare"
            autoFocus={initial?.focus ?? false}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            value={query ?? q}
            onChangeText={(next) => {
              setQ(next);
              onSearch(next);
            }}
            containerStyle={styles.field}
            style={text.body}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={dictation.listening ? "Stop dictating" : "Dictate"}
            accessibilityState={{ selected: dictation.listening }}
            hitSlop={space(2)}
            onPress={toggleDictation}
          >
            <IconMicrophone
              size={iconSize.md}
              strokeWidth={2}
              color={dictation.listening ? colors.primary : colors.foreground}
            />
          </Pressable>
        </FloatingField>
        <FloatingButton
          icon={IconX}
          label="Close search"
          searching
          glyph={iconSize.field}
          onPress={stop}
        />
      </View>
    </View>
  );
}

function useKeyboardHeight() {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const ios = Platform.OS === "ios";
    const follow = (shown: boolean) => (event?: KeyboardEvent) => {
      if (event?.duration) {
        LayoutAnimation.configureNext(
          LayoutAnimation.create(event.duration, LayoutAnimation.Types.keyboard, "opacity"),
        );
      }
      setHeight(shown ? (event?.endCoordinates.height ?? 0) : 0);
    };
    const show = Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", follow(true));
    const hide = Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", follow(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return height;
}

const styles = StyleSheet.create({
  stack: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2.5),
    paddingHorizontal: space(3),
  },
  field: { flex: 1, minWidth: 0 },
});
