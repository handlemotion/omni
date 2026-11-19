import { router } from "expo-router";
import type { ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Button } from "@/components/ui/button.tsx";
import { Text } from "@/components/ui/text.tsx";
import { space } from "@/theme/tokens.ts";

/**
 * A form in a sheet, as the web's form dialogs lay one out: Cancel, the title, the action, then
 * the fields. A form sheet has no navigation bar of its own, so the sheet draws this row.
 */
export function SheetForm(props: {
  title: string;
  action: string;
  disabled: boolean;
  saving: boolean;
  onSubmit: () => void;
  children: ReactNode;
}) {
  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheet}>
      <View style={styles.bar}>
        <Button intent="quiet" label="Cancel" onPress={() => router.back()} />
        <Text weight="semibold" numberOfLines={1} style={styles.title}>
          {props.title}
        </Text>
        <Button
          intent="quiet"
          label={props.action}
          disabled={props.disabled}
          isPending={props.saving}
          onPress={props.onSubmit}
        />
      </View>
      <View style={styles.fields}>{props.children}</View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  sheet: { paddingHorizontal: space(4), paddingTop: space(3), paddingBottom: space(8) },
  bar: { flexDirection: "row", alignItems: "center", gap: space(2), marginBottom: space(4) },
  title: { flex: 1, textAlign: "center" },
  fields: { gap: space(3) },
});
