import { useEffect, useState, type ComponentType } from "react";
import {
  Keyboard,
  LayoutAnimation,
  Platform,
  StyleSheet,
  View,
  type KeyboardEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { SvgProps } from "react-native-svg";
import { IconSearch, IconX } from "@/components/icons.ts";
import { FloatingButton, FloatingField, FloatingPill } from "@/components/ui/floating.tsx";
import { TextField } from "@/components/ui/text-field.tsx";
import { floatingControl, iconSize, space, text } from "@/theme/tokens.ts";

/** How far a list under the bar scrolls past its last row, so the bar never covers it. */
export const FLOATING_BAR_SPACE = floatingControl + space(10);

const SIDE = space(4);

export interface FloatingBarAction {
  icon: ComponentType<SvgProps & { size?: number }>;
  label: string;
  onPress: () => void;
}

/**
 * The shell's bottom controls, floating flat over the bottom edge: a search pill and the main
 * action in the brand's blue. A tap on the pill makes it a live field above the keyboard, with
 * a close button; `onSearch` hears every change, and "" once it closes.
 */
export function FloatingBar({
  placeholder,
  action,
  onSearch,
  onStart,
  onStop,
  initial,
}: {
  placeholder: string;
  /** A search already running (coming back from one of its results): the field reopens with it. */
  initial?: { searching: boolean; query: string };
  action: FloatingBarAction;
  onSearch: (q: string) => void;
  /** The field opened (the shell closes its menu and hides its top bar). */
  onStart?: () => void;
  /** The field closed. */
  onStop?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const [searching, setSearching] = useState(initial?.searching ?? false);
  const [q, setQ] = useState(initial?.query ?? "");
  const [focus, setFocus] = useState(false);
  const stop = () => {
    Keyboard.dismiss();
    setSearching(false);
    setQ("");
    onSearch("");
    onStop?.();
  };
  const bottom =
    searching && keyboard ? keyboard + space(2.5) : Math.max(insets.bottom - space(1), space(4));
  return (
    <View
      pointerEvents="box-none"
      style={[styles.bar, searching && styles.open, { paddingBottom: bottom }]}
    >
      {searching ? (
        <>
          <FloatingField icon={IconSearch}>
            <TextField
              label={placeholder}
              placeholder={placeholder}
              variant="bare"
              autoFocus={focus}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              value={q}
              onChangeText={(next) => {
                setQ(next);
                onSearch(next);
              }}
              containerStyle={styles.field}
              style={text.body}
            />
          </FloatingField>
          <FloatingButton
            icon={IconX}
            label="Close search"
            searching
            glyph={iconSize.field}
            onPress={stop}
          />
        </>
      ) : (
        <>
          <FloatingPill
            icon={IconSearch}
            label={placeholder}
            onPress={() => {
              onStart?.();
              setFocus(true);
              setSearching(true);
            }}
          />
          <FloatingButton
            icon={action.icon}
            label={action.label}
            onPress={action.onPress}
            primary
          />
        </>
      )}
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
  bar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: space(2.5),
    paddingHorizontal: SIDE,
  },
  open: { paddingHorizontal: space(3) },
  field: { flex: 1, minWidth: 0 },
});
