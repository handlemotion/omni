import { parseDate, type CalendarDate } from "@internationalized/date";
import { useMemo, useState, type ReactNode } from "react";
import { IconCalendar } from "@/components/icons/central";
import { Button as AriaButton } from "react-aria-components/Button";
import { Group } from "react-aria-components/Group";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { currencyCodes, parseMoney } from "@/lib/crm.ts";
import { Link } from "@/components/ui/link";
import { ItemLabel } from "@/components/ui/dropdown";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { TextField } from "@/components/ui/text-field";
import { useRecordHref } from "./record-trail.tsx";

const PLAIN_TRIGGER =
  "border-transparent bg-transparent enabled:hover:border-transparent enabled:hover:bg-hover";

export function FieldRow(props: { label: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex min-h-8 items-center gap-3">
      <span className="w-28 shrink-0 truncate text-sm text-muted-foreground">{props.label}</span>
      <div className="flex min-w-0 flex-1 items-center">{props.children}</div>
    </div>
  );
}

/** A text value edited in place; `onSave` gets the trimmed text, null when it was emptied. */
export function TextValue(props: {
  label: string;
  value: string | null;
  onSave: (value: string | null) => void;
  /** Refuses an empty value (a name): emptying it puts the old one back. */
  required?: boolean;
  type?: "text" | "email" | "tel";
  maxLength?: number;
  /** Turns what was typed into what is saved, or `undefined` when it isn't valid. */
  parse?: (text: string) => string | null | undefined;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? props.value ?? "";
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    const text = draft.trim();
    const next = props.parse ? props.parse(text) : text || null;
    if (next === undefined || (props.required && !next)) return;
    if (next !== (props.value ?? null)) props.onSave(next);
  };
  return (
    <FieldRow label={props.label}>
      <TextField
        aria-label={props.label}
        type={props.type}
        maxLength={props.maxLength ?? 500}
        value={shown}
        onChange={setDraft}
        className="w-full"
      >
        <Input
          plain
          autoComplete="off"
          placeholder="–"
          className="h-8 w-full truncate rounded-md px-2 hover:bg-hover focus:bg-hover"
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setDraft(null);
              queueMicrotask(() => (event.target as HTMLInputElement).blur());
            }
          }}
        />
      </TextField>
    </FieldRow>
  );
}

/** One of a few values (a stage, an owner), saved when picked; `mark` leads each (an avatar). */
export function ChoiceValue<T extends { id: string; name: string }>(props: {
  label: string;
  value: string | null;
  options: T[];
  onSave: (id: string) => void;
  mark?: (option: T) => ReactNode;
}) {
  const { mark } = props;
  const chosen = props.options.find((option) => option.id === props.value);
  return (
    <FieldRow label={props.label}>
      <Select
        aria-label={props.label}
        value={props.value}
        onChange={(id) => id && id !== props.value && props.onSave(id)}
        placeholder="–"
        className="w-full"
      >
        <SelectTrigger className={PLAIN_TRIGGER} leading={mark && chosen && mark(chosen)} />
        <SelectContent items={props.options}>
          {(option) => (
            <SelectItem id={option.id} textValue={option.name}>
              {mark?.(option)}
              <ItemLabel>{option.name}</ItemLabel>
            </SelectItem>
          )}
        </SelectContent>
      </Select>
    </FieldRow>
  );
}

/**
 * An amount and its currency: the amount edits in place (null when emptied, `undefined` when it
 * isn't a number), the currency is picked beside it.
 */
export function MoneyValue(props: {
  label: string;
  /** The amount as shown, formatted without its currency, which the picker beside it shows. */
  value: string | null;
  currency: string;
  onSaveAmount: (minor: number | null) => void;
  onSaveCurrency: (currency: string) => void;
}) {
  const codes = useMemo(() => currencyCodes().map((code) => ({ id: code, name: code })), []);
  return (
    <div className="flex min-h-8 items-center gap-1">
      <div className="min-w-0 flex-1">
        <TextValue
          label={props.label}
          value={props.value}
          parse={(text) => (text ? (parseMoney(text) === null ? undefined : text) : null)}
          onSave={(text) => props.onSaveAmount(text === null ? null : parseMoney(text))}
        />
      </div>
      <Select
        aria-label={`${props.label} currency`}
        value={props.currency}
        onChange={(code) => code && code !== props.currency && props.onSaveCurrency(code)}
        className="w-20 shrink-0"
      >
        <SelectTrigger className={`${PLAIN_TRIGGER} tabular-nums`} />
        <SelectContent items={codes}>
          {(code) => (
            <SelectItem id={code.id} textValue={code.name}>
              {code.name}
            </SelectItem>
          )}
        </SelectContent>
      </Select>
    </div>
  );
}

const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

/**
 * A calendar day (`YYYY-MM-DD`) picked in place: shown as text like the other values, a calendar
 * opening under it; null once it is cleared.
 */
export function DayValue(props: {
  label: string;
  value: string | null;
  onSave: (day: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const value = props.value ? parseDate(props.value) : null;
  const clear = props.value && (
    <Button
      intent="plain"
      size="sm"
      className="w-full"
      onPress={() => {
        setOpen(false);
        props.onSave(null);
      }}
    >
      Clear date
    </Button>
  );
  return (
    <FieldRow label={props.label}>
      <DatePicker
        aria-label={props.label}
        value={value}
        isOpen={open}
        onOpenChange={setOpen}
        onChange={(next: CalendarDate | null) => {
          const day = next?.toString() ?? null;
          if (day !== props.value) props.onSave(day);
        }}
        popover={{ placement: "bottom start", footer: clear }}
        className="min-w-0 flex-1"
      >
        <Group className="flex">
          <AriaButton
            className={cn(
              "flex h-8 w-full min-w-0 cursor-default items-center gap-x-2 rounded-lg px-2 text-start text-sm text-foreground outline-hidden",
              "hover:bg-hover focus-visible:bg-hover data-pressed:bg-hover",
            )}
          >
            <span className={cn("truncate tabular-nums", !props.value && "text-muted-foreground")}>
              {props.value ? DAY.format(new Date(`${props.value}T00:00`)) : "–"}
            </span>
            <IconCalendar
              aria-hidden
              className="ms-auto -me-1 size-4 shrink-0 text-muted-foreground"
            />
          </AriaButton>
        </Group>
      </DatePicker>
    </FieldRow>
  );
}

/** A value that is another record: its link, with an action after it (change, remove). */
export function LinkValue(props: {
  label: string;
  to?: { kind: "companies" | "people" | "deals"; id: string; name: string } | null;
  action?: ReactNode;
}) {
  const recordHref = useRecordHref();
  return (
    <FieldRow label={props.label}>
      <span className="flex min-w-0 flex-1 items-center gap-1 px-2">
        {props.to ? (
          <Link
            href={recordHref(props.to.kind, props.to.id)}
            className="truncate text-sm text-foreground underline-offset-2 hover:underline"
          >
            {props.to.name}
          </Link>
        ) : (
          <span className="text-sm text-muted-foreground">–</span>
        )}
      </span>
      {props.action}
    </FieldRow>
  );
}

/** A read-only value (a date, a count), with the same insets as the editable ones. */
export function PlainValue(props: { label: string; children: ReactNode }) {
  return (
    <FieldRow label={props.label}>
      <span className="truncate px-2 text-sm text-foreground tabular-nums">
        {props.children ?? <span className="text-muted-foreground">–</span>}
      </span>
    </FieldRow>
  );
}
