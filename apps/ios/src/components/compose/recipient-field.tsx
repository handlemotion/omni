import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Tag } from "@/components/ui/tag.tsx";
import { TextField } from "@/components/ui/text-field.tsx";
import { notAddresses, parseAddresses } from "@/lib/compose.ts";
import { space } from "@/theme/tokens.ts";
import { HeaderRow } from "./header-field.tsx";

/**
 * One recipient line, as the web's `RecipientField`: the label, the addresses as removable tags,
 * and a field. A comma, semicolon, space or Return turns typed addresses into tags; Delete in an
 * empty field takes the last one off. `end` sits at the end of the line (the Cc Bcc toggle).
 * Typed text the person never turned into a tag still goes out: Send reads it from `text`.
 */
export function RecipientField(props: {
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  /** What's typed and not yet a tag: held by the composer, which sends it too. */
  text: string;
  onText: (text: string) => void;
  autoFocus?: boolean;
  end?: ReactNode;
}) {
  const { value, onChange, text, onText: setText } = props;
  const add = (found: string[]) => {
    const fresh = found.filter((a) => !value.some((v) => v.toLowerCase() === a.toLowerCase()));
    if (fresh.length) onChange([...value, ...fresh]);
  };
  const commit = (typed: string) => {
    const found = parseAddresses(typed);
    if (!found.length) return false;
    add(found);
    setText(notAddresses(typed).join(", "));
    return true;
  };
  return (
    <HeaderRow label={props.label}>
      <View style={styles.value}>
        {value.map((address) => (
          <Tag
            key={address}
            label={address}
            onRemove={() => onChange(value.filter((a) => a !== address))}
          />
        ))}
        <TextField
          variant="bare"
          label={props.label}
          value={text}
          autoFocus={props.autoFocus}
          onChangeText={(next) => {
            if (!/[\s,;]$/.test(next) || !commit(next)) setText(next);
          }}
          onSubmitEditing={() => commit(text)}
          onBlur={() => commit(text)}
          onKeyPress={(event) => {
            if (event.nativeEvent.key === "Backspace" && !text && value.length)
              onChange(value.slice(0, -1));
          }}
          submitBehavior="submit"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="emailAddress"
          autoComplete="email"
          containerStyle={styles.field}
          style={styles.input}
        />
      </View>
      {props.end}
    </HeaderRow>
  );
}

const styles = StyleSheet.create({
  value: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space(1),
  },
  field: { flexGrow: 1, flexBasis: space(16) },
  input: { minHeight: space(8) },
});
