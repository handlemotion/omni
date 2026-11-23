import { useEffect, useState, type ComponentType, type ReactNode } from "react";
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
import { DOCK_HEIGHT } from "./module-dock.tsx";

/** How far a list under the bar and dock scrolls past its last row, so chrome never covers it. */
export const FLOATING_BAR_SPACE = floatingControl + DOCK_HEIGHT + space(12);

const SIDE = space(4);

export interface FloatingBarAction {
  icon: ComponentType<SvgProps & { size?: number }>;
  label: string;
  onPress: () => void;
}

/**
 * The shell's bottom controls, floating over the bottom edge: a module-focused search pill and its
 * main action above the module dock. A tap on the pill makes it a live field above the keyboard
 * (hiding the dock while searching), with a close button; `onSearch` hears every change, and ""
 * once it closes.
 */
export function FloatingBar({
  placeholder,
  action,
  onSearch,
  onStart,
  onStop,
  initial,
  query,
  dock,
}: {
  placeholder?: string;
  /** A search already running (coming back from one of its results): the field reopens with it. */
  initial?: { searching: boolean; query: string };
  /** What the open field shows, when the page under it can fill it (a recent search). */
  query?: string;
  action?: FloatingBarAction;
  onSearch: (q: string) => void;
  /** The field opened (the shell closes its drawer and hides its top bar). */
  onStart?: () => void;
  /** The field closed. */
  onStop?: () => void;
  /** The module switcher dock rendered beneath the search bar when not searching. */
  dock?: ReactNode;
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
    searching && keyboard ? keyboard + space(2.5) : Math.max(insets.bottom - space(1), space(3));
  return (
    <View pointerEvents="box-none" style={[styles.stack, { paddingBottom: bottom }]}>
      {searching && placeholder ? (
        <View pointerEvents="box-none" style={[styles.row, styles.open]}>
          <FloatingField icon={IconSearch}>
            <TextField
              label={placeholder}
              placeholder={placeholder}
              variant="bare"
              autoFocus={focus}
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
          </FloatingField>
          <FloatingButton
            icon={IconX}
            label="Close search"
            searching
            glyph={iconSize.field}
            onPress={stop}
          />
        </View>
      ) : (
        <>
          {placeholder || action ? (
            <View pointerEvents="box-none" style={styles.row}>
              {placeholder ? (
                <FloatingPill
                  icon={IconSearch}
                  label={placeholder}
                  onPress={() => {
                    onStart?.();
                    setFocus(true);
                    setSearching(true);
                  }}
                />
              ) : null}
              {action ? (
                <FloatingButton
                  icon={action.icon}
                  label={action.label}
                  onPress={action.onPress}
                  primary
                />
              ) : null}
            </View>
          ) : null}
          {dock}
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
  stack: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    gap: space(2.5),
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2.5),
    paddingHorizontal: SIDE,
  },
  open: { paddingHorizontal: space(3) },
  field: { flex: 1, minWidth: 0 },
});
