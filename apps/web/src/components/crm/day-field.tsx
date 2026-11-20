import { parseDate, type CalendarDate } from "@internationalized/date";
import { Button as AriaButton } from "react-aria-components/Button";
import { Group } from "react-aria-components/Group";
import { cn } from "cn";
import { IconCalendar, IconX } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/field";

const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

/**
 * A calendar day (`YYYY-MM-DD`) in a form: a field like a select's trigger that opens the
 * calendar the record pages use for close dates, with a clear button once an optional day is set.
 */
export function DayField(props: {
  label: string;
  value: string | null;
  onChange: (day: string | null) => void;
  isInvalid?: boolean;
  /** Always set: no clear button. */
  isRequired?: boolean;
  /** The last day it takes (`YYYY-MM-DD`). */
  max?: string;
}) {
  return (
    <div className="relative flex min-w-0 flex-col">
      <DatePicker
        value={props.value ? parseDate(props.value) : null}
        onChange={(next: CalendarDate | null) => props.onChange(next?.toString() ?? null)}
        isInvalid={props.isInvalid}
        isRequired={props.isRequired}
        maxValue={props.max ? parseDate(props.max) : undefined}
        popover={{ placement: "bottom start" }}
      >
        <Label>{props.label}</Label>
        <Group data-slot="control" className="flex">
          <AriaButton
            className={cn(
              "flex h-8 w-full min-w-0 cursor-default items-center gap-x-2 rounded-lg border border-input bg-(--control-bg,var(--color-background)) px-2 text-start text-sm text-foreground outline-hidden",
              "hover:border-muted-foreground/30 focus-visible:border-ring/70 data-pressed:border-ring/70",
              "group-data-invalid:border-danger-subtle-foreground/70",
            )}
          >
            <span className="truncate tabular-nums">
              {props.value ? DAY.format(new Date(`${props.value}T00:00`)) : ""}
            </span>
            {(!props.value || props.isRequired) && (
              <IconCalendar
                aria-hidden
                className="ms-auto -me-0.5 size-4 shrink-0 text-muted-foreground"
              />
            )}
          </AriaButton>
        </Group>
      </DatePicker>
      {props.value && !props.isRequired && (
        <Button
          intent="plain"
          size="sq-xs"
          aria-label={`Clear ${props.label.toLowerCase()}`}
          className="absolute end-1 bottom-1"
          onPress={() => props.onChange(null)}
        >
          <IconX />
        </Button>
      )}
    </div>
  );
}
