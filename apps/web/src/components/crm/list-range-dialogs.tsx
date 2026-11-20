import { parseDate, type CalendarDate } from "@internationalized/date";
import { useState } from "react";
import { SettingsFormDialog } from "@/components/settings/kit/settings-stacked-dialog";
import { DatePicker, DatePickerTrigger } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { TextField } from "@/components/ui/text-field";
import { parseMoney } from "@/lib/crm.ts";

const day = (iso: string | undefined) => (iso ? parseDate(iso) : null);

/** The close date window: either end may stay open. */
export function CloseDateDialog(props: {
  after: string | undefined;
  before: string | undefined;
  onSave: (after: string | undefined, before: string | undefined) => void;
  onClose: () => void;
}) {
  const [after, setAfter] = useState<CalendarDate | null>(day(props.after));
  const [before, setBefore] = useState<CalendarDate | null>(day(props.before));
  const backwards = !!after && !!before && after.compare(before) > 0;
  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
      title="Close date"
      action="Apply"
      disabled={(!after && !before) || backwards}
      onSubmit={() => {
        props.onSave(after?.toString(), before?.toString());
        props.onClose();
      }}
    >
      <DatePicker value={after} onChange={setAfter} aria-label="From">
        <Label>From</Label>
        <DatePickerTrigger />
      </DatePicker>
      <DatePicker value={before} onChange={setBefore} aria-label="To" isInvalid={backwards}>
        <Label>To</Label>
        <DatePickerTrigger />
      </DatePicker>
    </SettingsFormDialog>
  );
}

const whole = (minor: number | null) => (minor === null ? undefined : minor / 100);

/** The value range, in whole units: either end may stay open. */
export function ValueRangeDialog(props: {
  min: number | undefined;
  max: number | undefined;
  onSave: (min: number | undefined, max: number | undefined) => void;
  onClose: () => void;
}) {
  const [min, setMin] = useState(props.min === undefined ? "" : String(props.min));
  const [max, setMax] = useState(props.max === undefined ? "" : String(props.max));
  const low = whole(parseMoney(min));
  const high = whole(parseMoney(max));
  const invalid =
    (min.trim() !== "" && low === undefined) ||
    (max.trim() !== "" && high === undefined) ||
    (low !== undefined && high !== undefined && low > high);
  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
      title="Value"
      action="Apply"
      disabled={invalid || (low === undefined && high === undefined)}
      onSubmit={() => {
        props.onSave(low, high);
        props.onClose();
      }}
    >
      <TextField value={min} onChange={setMin} inputMode="decimal" autoFocus>
        <Label>At least</Label>
        <Input autoComplete="off" />
      </TextField>
      <TextField value={max} onChange={setMax} inputMode="decimal">
        <Label>At most</Label>
        <Input autoComplete="off" />
      </TextField>
    </SettingsFormDialog>
  );
}
