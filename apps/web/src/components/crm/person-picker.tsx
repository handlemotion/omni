import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@ui-sdk/react/combobox";
import { useState } from "react";
import { cn } from "cn";
import { byAddress } from "@/components/avatar/sender-avatar";
import { IconPlus } from "@/components/icons/central";
import { IconSearch } from "@/components/icons/sidebar";
import { buttonStyles } from "@/components/ui/button";
import { dropdownItemStyles } from "@/components/ui/dropdown";
import { popupSurface } from "@/components/ui/popover";
import { useCrmPeople } from "@/hooks/use-crm.ts";
import { useDebouncedValue } from "@/hooks/use-debounced-value.ts";
import { RecordMark } from "./record-list.tsx";

/**
 * The + beside a section's title, opening a search of the workspace's people under it; choosing
 * one runs `onAdd` and closes it.
 */
export function AddPersonPicker(props: {
  label: string;
  /** Already there: left out of the choices. */
  exclude: string[];
  onAdd: (personId: string) => void;
  /** While an addition saves, so the next one starts from the saved list. */
  isDisabled?: boolean;
}) {
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const q = useDebouncedValue(query.trim(), 200);
  const list = useCrmPeople(q);
  const people = list.people.filter((person) => !props.exclude.includes(person.id));
  return (
    <Combobox<string>
      value={null}
      onValueChange={(id) => {
        if (typeof id === "string") props.onAdd(id);
      }}
      query={query}
      onQueryChange={setQuery}
      filter={false}
      disabled={props.isDisabled}
      autoHighlight
      status={list.isPending ? "loading" : "idle"}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setQuery("");
      }}
      onOpenChangeComplete={(next) => !next && button?.focus()}
    >
      <ComboboxTrigger
        ref={setButton}
        aria-label={props.label}
        className={buttonStyles({ intent: "plain", size: "sq-xs" })}
      >
        <IconPlus data-slot="icon" />
      </ComboboxTrigger>
      <ComboboxContent
        anchor={button}
        side="bottom"
        align="end"
        sideOffset={8}
        collisionPadding={16}
        className={cn(popupSurface, "flex w-72 max-w-[calc(100vw-32px)] flex-col overflow-hidden")}
      >
        <div className="flex items-center gap-2 border-b px-3">
          <IconSearch aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <ComboboxInput
            autoFocus
            aria-label="Search people"
            placeholder="Search people"
            className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-hidden placeholder:text-muted-foreground"
          />
        </div>
        <ComboboxEmpty className="px-3 py-2.5 text-sm text-muted-foreground empty:hidden">
          {(state) => (state.empty && !list.isPending ? (q ? "No matches" : "No people") : null)}
        </ComboboxEmpty>
        <ComboboxList className="grid max-h-72 grid-cols-[auto_minmax(0,1fr)] overflow-y-auto p-1 empty:hidden">
          {people.map((person) => (
            <ComboboxItem
              key={person.id}
              value={person.id}
              label={person.name}
              className={dropdownItemStyles({
                className: "pe-2.5 data-highlighted:bg-accent",
              })}
            >
              <RecordMark
                name={person.name}
                who={byAddress(person.addresses[0]?.address)}
                size={16}
              />
              <span className="ms-2 truncate">{person.name}</span>
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
