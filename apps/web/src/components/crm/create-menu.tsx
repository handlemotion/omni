import { useState } from "react";
import {
  IconBuildings,
  IconChecklist,
  IconHandshake,
  IconPlus,
  IconUserRound,
} from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import type { ContextMenuAction } from "@/components/ui/context-menu";
import { Menu, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { useIsMobile } from "@/hooks/use-mobile.ts";
import { NewCompanyDialog, NewDealDialog, NewPersonDialog } from "./new-records.tsx";
import { RecordTargetDialog } from "./record-target.tsx";
import { NewTaskDialog, type PickedRecord } from "./task-dialog.tsx";

export type Creating = "task" | "company" | "person" | "deal";

const ITEMS: { id: Creating; label: string; icon: React.ReactNode }[] = [
  { id: "task", label: "Task", icon: <IconChecklist data-slot="icon" /> },
  { id: "company", label: "Company", icon: <IconBuildings data-slot="icon" /> },
  { id: "person", label: "Person", icon: <IconUserRound data-slot="icon" /> },
  { id: "deal", label: "Deal", icon: <IconHandshake data-slot="icon" /> },
];

const ICONS: Record<Creating, ContextMenuAction["icon"]> = {
  task: IconChecklist,
  company: IconBuildings,
  person: IconUserRound,
  deal: IconHandshake,
};

/**
 * The CRM's create flows, for New and for the right-click menus that offer it: `start` opens
 * one, `dialogs` must be rendered for it to show. A task first asks which record it is on,
 * unless `record` is given, which it starts on (and can change).
 */
export function useCreating(record?: PickedRecord) {
  const [creating, setCreating] = useState<Creating | "target" | null>(null);
  const [target, setTarget] = useState<PickedRecord | null>(record ?? null);
  const close = () => setCreating(null);
  const start = (id: Creating) => {
    if (id === "task" && !record) return setCreating("target");
    setTarget(record ?? null);
    setCreating(id);
  };
  const companyId = record?.kind === "companies" ? record.id : undefined;
  const entries = (only: Creating[] = ITEMS.map((item) => item.id)) =>
    only.map(
      (id) =>
        ({
          icon: ICONS[id],
          label: `New ${ITEMS.find((item) => item.id === id)?.label.toLowerCase()}`,
          onAction: () => start(id),
        }) satisfies ContextMenuAction,
    );
  const dialogs = (
    <>
      {creating === "target" && (
        <RecordTargetDialog
          onPick={(picked) => {
            setTarget(picked);
            setCreating("task");
          }}
          onClose={() => setCreating((now) => (now === "target" ? null : now))}
        />
      )}
      {creating === "task" && <NewTaskDialog initial={target} onClose={close} />}
      {creating === "company" && <NewCompanyDialog onClose={close} />}
      {creating === "person" && <NewPersonDialog companyId={companyId} onClose={close} />}
      {creating === "deal" && <NewDealDialog companyId={companyId} onClose={close} />}
    </>
  );
  return { start, entries, dialogs };
}

/** New, in every CRM header: a task, company, person or deal. */
export function CreateMenu(props: { record?: PickedRecord | undefined }) {
  const phone = useIsMobile();
  const creating = useCreating(props.record);
  return (
    <>
      <MenuTrigger>
        <Button size={phone ? "sq-sm" : "sm"} aria-label={phone ? "New" : undefined}>
          <IconPlus />
          {!phone && "New"}
        </Button>
        <Menu placement="bottom end" aria-label="New">
          {ITEMS.map((item) => (
            <MenuItem
              key={item.id}
              id={item.id}
              textValue={item.label}
              onAction={() => creating.start(item.id)}
            >
              {item.icon}
              <MenuLabel>{item.label}</MenuLabel>
            </MenuItem>
          ))}
        </Menu>
      </MenuTrigger>
      {creating.dialogs}
    </>
  );
}
