import { IconUpload } from "@/components/icons/lucide";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { FileTrigger } from "react-aria-components/FileTrigger";
import { SettingsRow, type SettingsRowIcon } from "./settings-row";

/** A file picked with a button; the chosen file's name shows before it. */
export function SettingsFileRow({
  accept,
  disabled,
  file,
  onFileChange,
  ...text
}: {
  accept?: string[];
  description?: ReactNode;
  disabled?: boolean;
  file: File | null;
  icon?: SettingsRowIcon;
  label: string;
  onFileChange: (file: File | null) => void;
}) {
  return (
    <SettingsRow
      {...text}
      control={
        <>
          {file && (
            <span className="max-w-40 truncate text-sm/4 text-muted-foreground">{file.name}</span>
          )}
          <FileTrigger
            acceptedFileTypes={accept}
            onSelect={(files) => onFileChange(files?.[0] ?? null)}
          >
            <Button intent="outline" isDisabled={disabled}>
              <IconUpload />
              {file ? "Replace" : "Upload"}
            </Button>
          </FileTrigger>
        </>
      }
    />
  );
}
