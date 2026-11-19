import { Stack, router } from "expo-router";
import { ScrollView, StyleSheet } from "react-native";
import { IdentitySection } from "@/components/settings/identity-section.tsx";
import { InboxesSection } from "@/components/settings/inboxes-section.tsx";
import { SettingsRow, SettingsSection } from "@/components/settings/settings-list.tsx";
import { signOut, useSession } from "@/lib/session.ts";
import { space } from "@/theme/tokens.ts";

/** Your settings on the phone: who you are, your inboxes' names, and Log out. */
export default function Settings() {
  if (!useSession().data) return null;
  return (
    <>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button onPress={() => router.back()}>Done</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.content}
      >
        <IdentitySection />
        <InboxesSection />
        <SettingsSection>
          <SettingsRow
            label="Log out"
            destructive
            onPress={() => {
              router.back();
              void signOut();
            }}
          />
        </SettingsSection>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  content: { padding: space(4), paddingBottom: space(12), gap: space(6) },
});
