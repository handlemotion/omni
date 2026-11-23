import { useEffect, useState, type ComponentType, type ReactNode } from "react";
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
import { FloatingButton, FloatingField, FloatingPill } from "@/components/ui/floating.tsx";
import { TextField } from "@/components/ui/text-field.tsx";
import { useDictation } from "@/lib/dictation.ts";
import { colors, floatingControl, iconSize, space, text } from "@/theme/tokens.ts";
import { DOCK_HEIGHT } from "./module-dock.tsx";

/** The gap between the search bar and the module dock under it. */
export const SEARCH_DOCK_GAP = space(5);

/** How far a list under the bar and dock scrolls past its last row, so chrome never covers it. */
export const FLOATING_BAR_SPACE = floatingControl + SEARCH_DOCK_GAP + DOCK_HEIGHT + space(10);

const SIDE = space(4);

export interface FloatingBarAction {
  icon: ComponentType<SvgProps & { size?: number }>;
  label: string;
  onPress: () => void;
}

/**
 * The shell's bottom controls: a full-width module-focused search bar (sized to match the login
 * buttons: 48pt tall, 1pt border on solid white) stacked directly above the bottom module dock.
 * Tapping the search bar opens the live field above the keyboard and hides the dock.
 */
export function FloatingBar({
  placeholder,
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
  const dictation = useDictation((heard) => {
    setQ(heard);
    onSearch(heard);
  });
  const stop = () => {
    dictation.stop();
    Keyboard.dismiss();
    setSearching(false);
    setQ("");
    onSearch("");
    onStop?.();
  };
  const open = () => {
    onStart?.();
    setFocus(true);
    setSearching(true);
  };
  const dictate = () => {
    onStart?.();
    setFocus(false);
    setSearching(true);
    void dictation.start();
  };
  const toggleDictation = () => {
    if (dictation.listening) dictation.stop();
    else void dictation.start();
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
      ) : (
        <>
          {placeholder ? (
            <View pointerEvents="box-none" style={styles.row}>
              <FloatingPill
                icon={IconSearch}
                label={placeholder}
                trailing={{ icon: IconMicrophone, label: "Dictate", onPress: dictate }}
                onPress={open}
              />
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
    gap: SEARCH_DOCK_GAP,
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
