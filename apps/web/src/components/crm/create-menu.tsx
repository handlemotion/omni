import { useState } from "react";
import {
  IconBuildings,
  IconChecklist,
  IconHandshake,
  IconPlus,
  IconUserRound,
} from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { useIsMobile } from "@/hooks/use-mobile.ts";
import { NewCompanyDialog, NewDealDialog, NewPersonDialog } from "./new-records.tsx";
import { RecordTargetDialog } from "./record-target.tsx";
import { NewTaskDialog, type PickedRecord } from "./task-dialog.tsx";

type Creating = "task" | "company" | "person" | "deal";

const ITEMS: { id: Creating; label: string; icon: React.ReactNode }[] = [
  { id: "task", label: "Task", icon: <IconChecklist data-slot="icon" /> },
  { id: "company", label: "Company", icon: <IconBuildings data-slot="icon" /> },
  { id: "person", label: "Person", icon: <IconUserRound data-slot="icon" /> },
  { id: "deal", label: "Deal", icon: <IconHandshake data-slot="icon" /> },
];

/**
 * New, in every CRM header: a task, company, person or deal. A task first asks which record it
 * is on, unless the page is a record's, which it starts on (and can change).
 */
export function CreateMenu(props: { record?: PickedRecord | undefined }) {
  const phone = useIsMobile();
  const [creating, setCreating] = useState<Creating | "target" | null>(null);
  const [target, setTarget] = useState<PickedRecord | null>(props.record ?? null);
  const close = () => setCreating(null);
  const start = (id: Creating) => {
    if (id === "task" && !props.record) return setCreating("target");
    setTarget(props.record ?? null);
    setCreating(id);
  };
  const companyId = props.record?.kind === "companies" ? props.record.id : undefined;
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
              onAction={() => start(item.id)}
            >
              {item.icon}
              <MenuLabel>{item.label}</MenuLabel>
            </MenuItem>
          ))}
        </Menu>
      </MenuTrigger>
      {creating === "target" && (
        <RecordTargetDialog
          onPick={(record) => {
            setTarget(record);
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
}
