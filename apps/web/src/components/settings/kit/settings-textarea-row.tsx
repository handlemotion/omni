import type { ReactNode } from "react";
import { Textarea, type TextAreaProps } from "@/components/ui/textarea";
import { SettingsRowText } from "./settings-row";

/**
 * A long text edited in place: the label above a full-width writing area instead of a control on
 * the right. It grows with its text up to the cap, then scrolls.
 */
export function SettingsTextareaRow({
  description,
  id,
  label,
  ...textarea
}: Omit<TextAreaProps, "className" | "id"> & {
  description?: ReactNode;
  id: string;
  label: ReactNode;
}) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-3 px-3 pt-2.5 pb-3">
      <div className="px-1">
        <SettingsRowText description={description} htmlFor={id} label={label} />
      </div>
      <Textarea {...textarea} id={id} className="max-h-80 min-h-28 resize-none" />
    </div>
  );
}
