import type { ComponentType } from "react";
import type { SvgProps } from "react-native-svg";
import {
  IconArrowDown,
  IconArrowUp,
  IconBuildings,
  IconCalendar,
  IconCheck,
  IconClock,
  IconCoins,
  IconFlag,
  IconName,
  IconNoOwner,
  IconUserRound,
  IconUsers,
} from "@/components/icons.ts";
import { MenuRow, MenuSection, SheetDivider } from "@/components/shell/menu-row.tsx";
import { Avatar } from "@/components/ui/avatar.tsx";
import { BottomSheet } from "@/components/ui/bottom-sheet.tsx";
import { sortsFor, type CrmPage, type ListSort, type ListView } from "@/lib/crm-lists.ts";
import { useMe, useMemberNames, useStages } from "@/lib/crm-timeline.ts";
import { colors, iconSize } from "@/theme/tokens.ts";

type Glyph = ComponentType<SvgProps & { size?: number }>;

export type ListSheetKind = "sort" | "filter";

const SORT_ICONS: Record<ListSort, Glyph> = {
  name: IconName,
  created: IconCalendar,
  updated: IconClock,
  value: IconCoins,
  closeOn: IconFlag,
};

const check = <IconCheck size={iconSize.md} color={colors.foreground} />;
const mark = (on: boolean) => (on ? check : undefined);
const face = (name: string) => <Avatar name={name} size={iconSize.menu} />;

/**
 * The sheet a list's chip opens: its orders and direction, or its filters (an owner; people
 * without a company; a deal's stage, while the deals show as a list). A pick closes it.
 */
export function ListSheet(props: {
  sheet: ListSheetKind | null;
  onClose: () => void;
  page: CrmPage;
  view: ListView;
  onChange: (view: ListView) => void;
  board: boolean;
}) {
  const { sheet, view } = props;
  const set = (change: Partial<ListView>) => () => {
    props.onClose();
    props.onChange({ ...view, ...change });
  };
  return (
    <BottomSheet
      isOpen={sheet !== null}
      onClose={props.onClose}
      title={sheet === "sort" ? "Sort" : "Filter"}
    >
      {sheet === "sort" ? <SortRows page={props.page} view={view} set={set} /> : null}
      {sheet === "filter" ? (
        <FilterRows page={props.page} view={view} set={set} board={props.board} />
      ) : null}
    </BottomSheet>
  );
}

type Set = (change: Partial<ListView>) => () => void;

function SortRows({ page, view, set }: { page: CrmPage; view: ListView; set: Set }) {
  return (
    <>
      {sortsFor(page).map((sort) => (
        <MenuRow
          key={sort.id}
          icon={SORT_ICONS[sort.id]}
          muted
          label={sort.label}
          trailing={mark(view.sort === sort.id)}
          onPress={set({ sort: sort.id })}
        />
      ))}
      <SheetDivider />
      <MenuRow
        icon={IconArrowUp}
        muted
        label="Ascending"
        trailing={mark(view.dir === "asc")}
        onPress={set({ dir: "asc" })}
      />
      <MenuRow
        icon={IconArrowDown}
        muted
        label="Descending"
        trailing={mark(view.dir === "desc")}
        onPress={set({ dir: "desc" })}
      />
    </>
  );
}

function FilterRows(props: { page: CrmPage; view: ListView; set: Set; board: boolean }) {
  const { page, view, set } = props;
  const me = useMe().data?.id;
  const members = [...(useMemberNames().data ?? [])].filter(([id]) => id !== me);
  const stages = useStages().data ?? [];
  return (
    <>
      <MenuSection label="Owner">
        <MenuRow
          icon={IconUsers}
          muted
          label="Anyone"
          trailing={mark(view.owner === null)}
          onPress={set({ owner: null })}
        />
        {me ? (
          <MenuRow
            icon={IconUserRound}
            muted
            label="Me"
            trailing={mark(view.owner === me)}
            onPress={set({ owner: me })}
          />
        ) : null}
        <MenuRow
          icon={IconNoOwner}
          muted
          label="No owner"
          trailing={mark(view.owner === "none")}
          onPress={set({ owner: "none" })}
        />
        {members.map(([id, name]) => (
          <MenuRow
            key={id}
            lead={face(name)}
            label={name}
            trailing={mark(view.owner === id)}
            onPress={set({ owner: id })}
          />
        ))}
      </MenuSection>
      {page === "people" ? (
        <MenuSection label="Company">
          <MenuRow
            icon={IconBuildings}
            muted
            label="No company"
            trailing={mark(view.noCompany)}
            onPress={set({ noCompany: !view.noCompany })}
          />
        </MenuSection>
      ) : null}
      {page === "deals" && !props.board && stages.length ? (
        <MenuSection label="Stage">
          <MenuRow
            icon={IconFlag}
            muted
            label="Any stage"
            trailing={mark(view.stage === null)}
            onPress={set({ stage: null })}
          />
          {stages.map((stage) => (
            <MenuRow
              key={stage.id}
              icon={IconFlag}
              muted
              label={stage.name}
              trailing={mark(view.stage === stage.id)}
              onPress={set({ stage: stage.id })}
            />
          ))}
        </MenuSection>
      ) : null}
    </>
  );
}
