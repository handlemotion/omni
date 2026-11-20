import { useMemo, useState } from "react";
import {
  IconBuildings,
  IconHandshake,
  IconProjects,
  IconUserRound,
} from "@/components/icons/central";
import {
  Command,
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useCrmDeals, useCrmFind } from "@/hooks/use-crm.ts";
import { useDebouncedValue } from "@/hooks/use-debounced-value.ts";
import type { PickedRecord } from "./task-dialog.tsx";

const WON = { kind: "won" } as const;
const OPEN = { kind: "open" } as const;
const NONE = "none";

/**
 * Which record a new task is on, as a command menu: the projects first, the rest by name once
 * something is typed, and "No record" last.
 */
export function RecordTargetDialog(props: {
  onPick: (record: PickedRecord | null) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const q = useDebouncedValue(text.trim(), 150);
  const groups = useTargets(q);
  const pick = (record: PickedRecord | null) => {
    props.onPick(record);
    props.onClose();
  };
  return (
    <CommandDialog label="Choose a record" isOpen onOpenChange={(open) => !open && props.onClose()}>
      <Command label="Choose a record" shouldFilter={false} loop>
        <CommandInput
          autoFocus
          value={text}
          onValueChange={setText}
          placeholder="Which project, deal, company or person is it for?"
        />
        <CommandList>
          {groups.map((group) =>
            group.records.length ? (
              <CommandGroup key={group.heading} heading={group.heading}>
                {group.records.map((record) => (
                  <CommandItem
                    key={`${record.kind}:${record.id}`}
                    value={`${record.kind}:${record.id}`}
                    onSelect={() => pick(record)}
                  >
                    {group.icon}
                    <span className="min-w-0 truncate">{record.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null,
          )}
          <CommandGroup>
            <CommandItem value={NONE} onSelect={() => pick(null)}>
              <span className="size-4" />
              <span className="text-muted-foreground">No record</span>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

function useTargets(q: string) {
  const won = useCrmDeals(WON, { all: true }).deals;
  const open = useCrmDeals(OPEN, { all: true }).deals;
  const found = useCrmFind(q).data;
  return useMemo(() => {
    const deal = (d: { id: string; name: string }) => ({
      kind: "deals" as const,
      id: d.id,
      name: d.name,
    });
    if (!q) {
      return [
        { heading: "Projects", icon: <IconProjects />, records: won.map(deal) },
        { heading: "Deals", icon: <IconHandshake />, records: open.map(deal) },
      ];
    }
    return [
      { heading: "Deals", icon: <IconHandshake />, records: (found?.deals ?? []).map(deal) },
      {
        heading: "Companies",
        icon: <IconBuildings />,
        records: (found?.companies ?? []).map((c) => ({
          kind: "companies" as const,
          id: c.id,
          name: c.name,
        })),
      },
      {
        heading: "People",
        icon: <IconUserRound />,
        records: (found?.people ?? []).map((p) => ({
          kind: "people" as const,
          id: p.id,
          name: p.name || p.addresses[0]?.address || "",
        })),
      },
    ];
  }, [q, won, open, found]);
}
