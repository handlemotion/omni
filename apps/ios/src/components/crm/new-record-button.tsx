import { Stack, router } from "expo-router";
import type { CrmPage } from "@/lib/crm.ts";
import type { RecordFormKind } from "./record-form-sheet.tsx";

const NEW: Record<CrmPage, { kind: RecordFormKind; label: string }> = {
  companies: { kind: "company", label: "New company" },
  people: { kind: "person", label: "New person" },
  deals: { kind: "deal", label: "New deal" },
};

/**
 * A CRM list's "+" header button, opening the new record's sheet. An element, not a component:
 * the native header reads its buttons straight from its children.
 */
export function newRecordButton(page: CrmPage) {
  const { kind, label } = NEW[page];
  return (
    <Stack.Toolbar.Button
      icon="plus"
      accessibilityLabel={label}
      onPress={() => router.push({ pathname: "/crm/form", params: { kind } })}
    />
  );
}
