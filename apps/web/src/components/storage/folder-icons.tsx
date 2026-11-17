import { useState, type ComponentType } from "react";
import {
  IconAnalytics,
  IconArchive,
  IconBook,
  IconBrush,
  IconBuildings,
  IconCode,
  IconCoins,
  IconGlobe,
  IconHeart,
  IconHome,
  IconLightBulb,
  IconLock,
  IconMegaphone,
  IconPackage,
  IconRocket,
  IconSparkle,
  IconStar,
  IconTarget,
  IconTrophy,
  IconVideo,
} from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useChangeNode, useFolderIcons } from "@/hooks/use-storage.ts";
import type { StorageFolderIcon, StorageNode } from "@/lib/storage.ts";
import { FileGlyph } from "./file-glyph.tsx";
import { storageErrorToast } from "./storage-errors.ts";

type Glyph = ComponentType<{ className?: string }>;

/** Each glyph and the name a screen reader gives it: `STORAGE_FOLDER_ICONS`, which the API checks. */
export const FOLDER_ICONS = {
  rocket: { icon: IconRocket, label: "Rocket" },
  star: { icon: IconStar, label: "Star" },
  heart: { icon: IconHeart, label: "Heart" },
  sparkle: { icon: IconSparkle, label: "Sparkle" },
  "light-bulb": { icon: IconLightBulb, label: "Light bulb" },
  target: { icon: IconTarget, label: "Target" },
  trophy: { icon: IconTrophy, label: "Trophy" },
  megaphone: { icon: IconMegaphone, label: "Megaphone" },
  analytics: { icon: IconAnalytics, label: "Chart" },
  coins: { icon: IconCoins, label: "Coins" },
  buildings: { icon: IconBuildings, label: "Buildings" },
  globe: { icon: IconGlobe, label: "Globe" },
  home: { icon: IconHome, label: "Home" },
  book: { icon: IconBook, label: "Book" },
  code: { icon: IconCode, label: "Code" },
  brush: { icon: IconBrush, label: "Brush" },
  video: { icon: IconVideo, label: "Video" },
  archive: { icon: IconArchive, label: "Archive" },
  package: { icon: IconPackage, label: "Package" },
  lock: { icon: IconLock, label: "Lock" },
} as const satisfies Record<string, { icon: Glyph; label: string }>;
type FolderIconKey = keyof typeof FOLDER_ICONS & StorageFolderIcon;

const known = (icon: string | null | undefined): icon is FolderIconKey =>
  !!icon && icon in FOLDER_ICONS;

/** The folder's glyph: its chosen one, or the folder (also for a glyph this build doesn't know). */
export function FolderIcon(props: { icon: string | null | undefined; className?: string }) {
  if (!known(props.icon)) return <FileGlyph kind="folder" className={props.className} />;
  const Icon = FOLDER_ICONS[props.icon].icon;
  return <Icon className={props.className} />;
}

const FOLDER = "folder";

/** Picks a top-level folder's sidebar glyph, the folder first. */
export function FolderIconDialog(props: { node: StorageNode; onClose: () => void }) {
  const change = useChangeNode();
  const saved = useFolderIcons(props.node.space);
  const current = saved.icons[props.node.id];
  const [choice, setChoice] = useState<string | null>(null);
  const picked = choice ?? (known(current) ? current : FOLDER);
  const save = () =>
    change.mutate(
      { id: props.node.id, icon: picked === FOLDER ? null : (picked as FolderIconKey) },
      {
        onSuccess: props.onClose,
        onError: (error) => storageErrorToast(error, "The icon was not changed"),
      },
    );
  return (
    <Dialog size="sm" isOpen onOpenChange={(open) => !open && !change.isPending && props.onClose()}>
      <DialogHeader className="pe-0">
        <DialogTitle className="break-words">Icon for “{props.node.name}”</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <ToggleGroup
          size="sq-md"
          aria-label="Icon"
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[picked]}
          onSelectionChange={(keys) => {
            const [key] = [...keys];
            if (key !== undefined) setChoice(String(key));
          }}
          className="flex-wrap"
        >
          <ToggleGroupItem id={FOLDER} aria-label="Folder">
            <FileGlyph kind="folder" />
          </ToggleGroupItem>
          {Object.entries(FOLDER_ICONS).map(([key, { icon: Icon, label }]) => (
            <ToggleGroupItem key={key} id={key} aria-label={label}>
              <Icon />
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </DialogBody>
      <DialogFooter>
        <DialogClose>Cancel</DialogClose>
        <Button
          isPending={change.isPending}
          isDisabled={choice === null && !saved.isLoaded}
          onPress={save}
        >
          Save
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
