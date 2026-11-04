import type { ReactNode } from "react";
import { Button as AvatarButton } from "react-aria-components/Button";
import { FileTrigger } from "react-aria-components/FileTrigger";
import { Button } from "@/components/ui/button";
import { Loader } from "@/components/ui/loader";
import { SettingsRow } from "./settings-row";

export const SETTINGS_AVATAR_ACCEPT = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/**
 * A picture. The avatar itself is the control: pressing it picks a new file; once one is set,
 * Remove sits beside it. Without `onUpload` it only shows the picture.
 */
export function SettingsAvatarRow({
  avatar,
  busy,
  description,
  hasImage,
  label,
  onRemove,
  onUpload,
}: {
  /** The current picture or its fallback, shown on the right. */
  avatar: ReactNode;
  busy?: boolean;
  description?: ReactNode;
  hasImage: boolean;
  label: string;
  onRemove?: () => void;
  onUpload?: (file: File) => void;
}) {
  if (!onUpload) return <SettingsRow control={avatar} description={description} label={label} />;
  return (
    <SettingsRow
      description={description}
      label={label}
      control={
        <>
          {busy && <Loader className="size-icon text-muted-foreground" />}
          {hasImage && onRemove && (
            <Button intent="plain" isDisabled={busy} onPress={onRemove}>
              Remove
            </Button>
          )}
          <FileTrigger
            acceptedFileTypes={SETTINGS_AVATAR_ACCEPT}
            onSelect={(files) => {
              const file = files?.[0];
              if (file) onUpload(file);
            }}
          >
            <AvatarButton
              aria-label={`Upload ${label.toLowerCase()}`}
              className="flex rounded-full outline-hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
              isDisabled={busy}
            >
              {avatar}
            </AvatarButton>
          </FileTrigger>
        </>
      }
    />
  );
}
