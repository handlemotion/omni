import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Avatar } from "@/components/ui/avatar.tsx";
import { ChipButton, chipHeight } from "@/components/ui/chip-button.tsx";
import { TextField } from "@/components/ui/text-field.tsx";
import { notAddresses, parseAddresses } from "@/lib/compose.ts";
import { iconSize, space, text as type } from "@/theme/tokens.ts";
import { HeaderRow } from "./header-field.tsx";

/**
 * One recipient line, as the web's `RecipientField`: the label, the addresses as removable chips
 * (a hairline pill holding the person's round avatar and their name, or their address),
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
  /** Names to show for addresses (a reply's people), lowercased addresses as keys. */
  names?: ReadonlyMap<string, string>;
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
        {value.map((address) => {
          const name = props.names?.get(address.toLowerCase()) ?? address;
          return (
            <ChipButton
              key={address}
              variant="chip"
              label={name}
              accessibilityLabel={`Remove ${name}`}
              lead={<Avatar name={name} logo={{ address }} size={iconSize.lg} />}
              onPress={() => onChange(value.filter((a) => a !== address))}
            />
          );
        })}
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
    gap: space(2),
  },
  field: { flexGrow: 1, flexBasis: space(16) },
  input: { ...type.subhead, minHeight: chipHeight },
});
