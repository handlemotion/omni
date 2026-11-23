import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CrmSearch } from "@/components/crm/crm-search.tsx";
import { DriveSearch } from "@/components/drive/drive-search.tsx";
import { IconSearch, IconX } from "@/components/icons.ts";
import { SearchResults } from "@/components/inbox/search-results.tsx";
import { SearchStart } from "@/components/inbox/search-start.tsx";
import { DOCK_HEIGHT, ModuleDock } from "@/components/shell/module-dock.tsx";
import { BottomFade } from "@/components/ui/bottom-fade.tsx";
import { FloatingField } from "@/components/ui/floating.tsx";
import { Segmented } from "@/components/ui/segmented.tsx";
import { TextField } from "@/components/ui/text-field.tsx";
import { useDebounced } from "@/lib/use-debounced.ts";
import { hasCrm, useWorkspace } from "@/lib/workspace.ts";
import { colors, iconSize, space, text } from "@/theme/tokens.ts";

type Scope = "mail" | "drive" | "crm";

const FOOTER_SPACE = DOCK_HEIGHT + space(10);

function initialScope(from: string | undefined, crm: boolean) {
  if (from === "drive") return "drive" satisfies Scope;
  if (from === "crm" && crm) return "crm" satisfies Scope;
  return "mail" satisfies Scope;
}

/** Global Search tab: Liquid Glass top search bar (auto-focused), scope pills, and bottom dock. */
export default function SearchScreen() {
  const params = useLocalSearchParams<{ in?: string }>();
  const insets = useSafeAreaInsets();
  const crm = hasCrm(useWorkspace().active);
  const [scope, setScope] = useState<Scope>(() => initialScope(params.in, crm));
  const [query, setQuery] = useState("");
  const typed = query.trim();
  const q = useDebounced(typed);
  const activeScope: Scope = scope === "crm" && !crm ? "mail" : scope;

  const scopes: { id: Scope; label: string }[] = [
    { id: "mail", label: "Mail" },
    { id: "drive", label: "Drive" },
    ...(crm ? [{ id: "crm" as const, label: "CRM" }] : []),
  ];

  const bottom = Math.max(insets.bottom - space(1), space(3));

  return (
    <View style={styles.page}>
      <View style={[styles.top, { paddingTop: insets.top + space(2) }]}>
        <View style={styles.barRow}>
          <FloatingField icon={IconSearch}>
            <TextField
              label="Search"
              placeholder="Search"
              variant="bare"
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              value={query}
              onChangeText={setQuery}
              containerStyle={styles.field}
              style={text.body}
            />
            {query ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Clear search"
                hitSlop={space(2)}
                onPress={() => setQuery("")}
              >
                <IconX size={iconSize.sm} color={colors.mutedForeground} />
              </Pressable>
            ) : null}
          </FloatingField>
        </View>
        <View style={styles.scopes}>
          <Segmented options={scopes} value={activeScope} onChange={setScope} />
        </View>
      </View>

      <View style={styles.results}>
        {typed ? (
          activeScope === "mail" ? (
            <SearchResults q={q} footerSpace={FOOTER_SPACE} />
          ) : activeScope === "drive" ? (
            <DriveSearch q={q} footerSpace={FOOTER_SPACE} />
          ) : (
            <CrmSearch q={q} footerSpace={FOOTER_SPACE} />
          )
        ) : activeScope === "mail" ? (
          <SearchStart onSearch={setQuery} />
        ) : null}
      </View>

      <BottomFade />
      <View pointerEvents="box-none" style={[styles.dockWrap, { paddingBottom: bottom }]}>
        <ModuleDock isSearch />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  top: { paddingHorizontal: space(4), gap: space(2.5), paddingBottom: space(2) },
  barRow: { flexDirection: "row", alignItems: "center" },
  field: { flex: 1, minWidth: 0 },
  scopes: { flexDirection: "row" },
  results: { flex: 1 },
  dockWrap: { position: "absolute", left: 0, right: 0, bottom: 0 },
});
