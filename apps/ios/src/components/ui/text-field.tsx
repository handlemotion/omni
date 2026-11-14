import { useState } from "react";
import { StyleSheet, TextInput, View, type TextInputProps } from "react-native";
import { colors, fonts, radius, space, text } from "@/theme/tokens.ts";

export interface TextFieldProps extends TextInputProps {
  /** Read by VoiceOver; the frame shows no visible label, as on the web. */
  label: string;
}

/** A text field. Focus shows as a ring-coloured border only: no glow, no tint. */
export function TextField({ label, style, onFocus, onBlur, ...props }: TextFieldProps) {
  const [focused, setFocused] = useState(false);
  return (
    <View>
      <TextInput
        {...props}
        accessibilityLabel={label}
        placeholderTextColor={colors.subtleForeground}
        onFocus={(event) => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
        style={[styles.input, focused && styles.focused, style]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  input: {
    ...text.lg,
    fontFamily: fonts.regular,
    color: colors.foreground,
    height: 52,
    paddingHorizontal: space(4),
    borderRadius: radius.field,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  focused: { borderColor: colors.primary },
});
