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
  IconUsers,
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
import { useUpdateTeamspace } from "@/hooks/use-storage.ts";
import type { StorageSpaceIcon } from "@/lib/storage.ts";
import type { StorageTeamspace } from "@/lib/storage-teamspaces.ts";
import { storageErrorToast } from "./storage-errors.ts";

type Glyph = ComponentType<{ className?: string }>;

/** Each glyph and the name a screen reader gives it: `STORAGE_FOLDER_ICONS`, which the API checks. */
export const SPACE_ICONS = {
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
type SpaceIconKey = keyof typeof SPACE_ICONS & StorageSpaceIcon;

const known = (icon: string | null | undefined): icon is SpaceIconKey =>
  !!icon && icon in SPACE_ICONS;

function DefaultIcon(props: { private: boolean; className?: string }) {
  const Icon = props.private ? IconLock : IconUsers;
  return <Icon className={props.className} />;
}

/** A space's glyph: its chosen one, or the default (also for a glyph this build doesn't know). */
export function SpaceIcon(props: {
  teamspace: Pick<StorageTeamspace, "icon" | "private">;
  className?: string;
}) {
  const { icon } = props.teamspace;
  if (!known(icon))
    return <DefaultIcon private={props.teamspace.private} className={props.className} />;
  const Icon = SPACE_ICONS[icon].icon;
  return <Icon className={props.className} />;
}

const DEFAULT = "default";

/** Picks a space's sidebar glyph, its default first. */
export function SpaceIconDialog(props: { teamspace: StorageTeamspace; onClose: () => void }) {
  const { teamspace } = props;
  const update = useUpdateTeamspace();
  const [picked, setPicked] = useState<string>(known(teamspace.icon) ? teamspace.icon : DEFAULT);
  const save = () =>
    update.mutate(
      { id: teamspace.id, icon: picked === DEFAULT ? null : (picked as SpaceIconKey) },
      {
        onSuccess: props.onClose,
        onError: (error) => storageErrorToast(error, "The icon was not changed"),
      },
    );
  return (
    <Dialog size="sm" isOpen onOpenChange={(open) => !open && !update.isPending && props.onClose()}>
      <DialogHeader className="pe-0">
        <DialogTitle className="break-words">Icon for “{teamspace.name}”</DialogTitle>
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
            if (key !== undefined) setPicked(String(key));
          }}
          className="flex-wrap"
        >
          <ToggleGroupItem id={DEFAULT} aria-label="Default">
            <DefaultIcon private={teamspace.private} />
          </ToggleGroupItem>
          {Object.entries(SPACE_ICONS).map(([key, { icon: Icon, label }]) => (
            <ToggleGroupItem key={key} id={key} aria-label={label}>
              <Icon />
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </DialogBody>
      <DialogFooter>
        <DialogClose>Cancel</DialogClose>
        <Button isPending={update.isPending} onPress={save}>
          Save
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
