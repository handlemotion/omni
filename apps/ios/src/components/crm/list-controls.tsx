import { useState } from "react";
import { ScrollView, StyleSheet } from "react-native";
import {
  IconArchive,
  IconArrowDown,
  IconArrowUp,
  IconBoard,
  IconChevronDown,
  IconFilter,
} from "@/components/icons.ts";
import { ChipButton } from "@/components/ui/chip-button.tsx";
import { filterCount, sortLabel, type CrmPage, type ListView } from "@/lib/crm-lists.ts";
import { colors, gutter, iconSize, space } from "@/theme/tokens.ts";
import { ListSheet, type ListSheetKind } from "./list-sheet.tsx";

const chevron = <IconChevronDown size={iconSize.sm} color={colors.mutedForeground} />;

/**
 * A list's controls, in a row of chips over it: on Deals the board, then its order (and
 * direction), its filters, and the archived records instead of the live ones.
 */
export function ListControls(props: {
  page: CrmPage;
  view: ListView;
  onChange: (view: ListView) => void;
  board?: { on: boolean; toggle: () => void };
}) {
  const { view, onChange } = props;
  const [sheet, setSheet] = useState<ListSheetKind | null>(null);
  const filters = filterCount({ ...view, archived: false });
  return (
    <>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        style={styles.bar}
      >
        {props.board ? (
          <ChipButton
            variant="chip"
            label="Board"
            icon={IconBoard}
            isSelected={props.board.on}
            onPress={props.board.toggle}
          />
        ) : null}
        <ChipButton
          variant="chip"
          label={sortLabel(view.sort)}
          icon={view.dir === "asc" ? IconArrowUp : IconArrowDown}
          trailing={chevron}
          onPress={() => setSheet("sort")}
        />
        <ChipButton
          variant="chip"
          label={filters ? `Filter ${filters}` : "Filter"}
          icon={IconFilter}
          trailing={chevron}
          isSelected={filters > 0}
          onPress={() => setSheet("filter")}
        />
        <ChipButton
          variant="chip"
          label="Archived"
          icon={IconArchive}
          isSelected={view.archived}
          onPress={() => onChange({ ...view, archived: !view.archived })}
        />
      </ScrollView>
      <ListSheet
        sheet={sheet}
        onClose={() => setSheet(null)}
        page={props.page}
        view={view}
        onChange={onChange}
        board={!!props.board?.on}
      />
    </>
  );
}

const styles = StyleSheet.create({
  bar: { flexGrow: 0 },
  row: { gap: space(2), paddingHorizontal: gutter, paddingVertical: space(2) },
});
