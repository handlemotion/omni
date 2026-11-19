import { useEffect, useState } from "react";
import { Alert, StyleSheet, View } from "react-native";
import { TextField } from "@/components/ui/text-field.tsx";
import { useSession } from "@/lib/session.ts";
import { useUpdateName } from "@/lib/settings.ts";
import { space, text } from "@/theme/tokens.ts";
import { SettingsRow, SettingsSection } from "./settings-list.tsx";

/** Your name, edited in place and saved when you finish typing, and the email you sign in with. */
export function IdentitySection() {
  const user = useSession().data?.user;
  const saved = user?.name ?? "";
  const [draft, setDraft] = useState(saved);
  const rename = useUpdateName();
  useEffect(() => setDraft(saved), [saved]);

  const save = () => {
    const next = draft.trim();
    if (!next || next === saved) {
      setDraft(saved);
      return;
    }
    rename.mutate(next, {
      onError: () => {
        setDraft(saved);
        Alert.alert("Your name could not be changed.");
      },
    });
  };

  return (
    <SettingsSection title="Identity">
      <SettingsRow
        label="Name"
        control={
          <View style={styles.grow}>
            <TextField
              label="Name"
              value={draft}
              placeholder="Your name"
              maxLength={120}
              autoComplete="name"
              textContentType="name"
              returnKeyType="done"
              editable={!rename.isPending}
              onChangeText={setDraft}
              onEndEditing={save}
              style={styles.field}
            />
          </View>
        }
      />
      <SettingsRow label="Email" value={user?.email} />
    </SettingsSection>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1, marginLeft: space(4) },
  field: {
    ...text.md,
    height: text.md.lineHeight + space(2),
    borderWidth: 0,
    paddingHorizontal: 0,
    backgroundColor: "transparent",
    textAlign: "right",
  },
});
