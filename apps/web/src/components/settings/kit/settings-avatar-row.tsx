import { IconArrowOutOfBox } from "central-icons-outlined/IconArrowOutOfBox";
import { IconTrashCanSimple } from "central-icons-outlined/IconTrashCanSimple";
import { useRef, type ReactNode } from "react";
import { Button as AvatarButton } from "react-aria-components/Button";
import { FileTrigger } from "react-aria-components/FileTrigger";
import { Loader } from "@/components/ui/loader";
import { Menu, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { SettingsRow } from "./settings-row";

export const SETTINGS_AVATAR_ACCEPT = ["image/png", "image/jpeg", "image/webp", "image/gif"];

const avatarButtonClassName =
  "flex rounded-full outline-hidden transition-[scale] duration-150 ease-out pressed:scale-97 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50 motion-reduce:pressed:scale-100";

/**
 * A picture (transitive's avatar row). The image itself is the control: with none set it picks
 * a file; once one is, it opens a menu to upload a new one or remove it. Without `onUpload` it
 * only shows the picture.
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
  const input = useRef<HTMLInputElement>(null);
  if (!onUpload) return <SettingsRow control={avatar} description={description} label={label} />;
  const noun = label.toLowerCase();
  return (
    <SettingsRow
      description={description}
      label={label}
      control={
        <>
          {busy && <Loader className="size-icon text-muted-foreground" />}
          {/* One hidden picker, opened by the image or by the menu's Upload. */}
          <FileTrigger
            ref={input}
            acceptedFileTypes={SETTINGS_AVATAR_ACCEPT}
            onSelect={(files) => {
              const file = files?.[0];
              if (file) onUpload(file);
            }}
          />
          {hasImage ? (
            <MenuTrigger>
              <AvatarButton
                aria-label={`Change ${noun}`}
                className={avatarButtonClassName}
                isDisabled={busy}
              >
                {avatar}
              </AvatarButton>
              <Menu placement="bottom end">
                <MenuItem
                  textValue={`Upload a new ${noun}`}
                  onAction={() => input.current?.click()}
                >
                  <IconArrowOutOfBox data-slot="icon" />
                  <MenuLabel>Upload a new {noun}</MenuLabel>
                </MenuItem>
                {onRemove && (
                  <MenuItem intent="danger" textValue={`Remove ${noun}`} onAction={onRemove}>
                    <IconTrashCanSimple data-slot="icon" />
                    <MenuLabel>Remove {noun}</MenuLabel>
                  </MenuItem>
                )}
              </Menu>
            </MenuTrigger>
          ) : (
            <AvatarButton
              aria-label={`Upload ${noun}`}
              className={avatarButtonClassName}
              isDisabled={busy}
              onPress={() => input.current?.click()}
            >
              {avatar}
            </AvatarButton>
          )}
        </>
      }
    />
  );
}
