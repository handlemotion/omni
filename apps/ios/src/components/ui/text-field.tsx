import { useState } from "react";
import {
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import { colors, fonts, radius, space, text } from "@/theme/tokens.ts";

export interface TextFieldProps extends TextInputProps {
  /** Read by VoiceOver; the frame shows no visible label, as on the web. */
  label: string;
  /** `well`: a filled pill. `bare`: no frame, for a row that draws its own (a mail header). */
  variant?: "well" | "bare";
  /** The field's box in its parent's layout: how it grows in a row of tags, or fills a sheet. */
  containerStyle?: StyleProp<ViewStyle>;
}

/** A text field. Focus shows as a ring-coloured border only: no glow, no tint. */
export function TextField({
  label,
  variant = "well",
  containerStyle,
  style,
  onFocus,
  onBlur,
  ...props
}: TextFieldProps) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={containerStyle}>
      <TextInput
        {...props}
        accessibilityLabel={label}
        maxFontSizeMultiplier={1.4}
        placeholderTextColor={colors.subtleForeground}
        onFocus={(event) => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
        style={[
          variant === "bare" ? styles.bare : [styles.input, focused && styles.focused],
          style,
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  input: {
    ...text.body,
    fontFamily: fonts.regular,
    color: colors.foreground,
    height: 48,
    paddingHorizontal: space(5),
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  focused: { borderColor: colors.primary },
  bare: {
    ...text.body,
    fontFamily: fonts.regular,
    color: colors.foreground,
    padding: 0,
    minWidth: 0,
    outlineWidth: 0,
  },
});
