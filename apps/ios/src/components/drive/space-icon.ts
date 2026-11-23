import type { ComponentType } from "react";
import type { SvgProps } from "react-native-svg";
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
} from "@/components/icons.ts";
import type { DriveTeamspace } from "@/lib/drive.ts";

type Glyph = ComponentType<SvgProps & { size?: number }>;

const SPACE_ICONS: Record<string, Glyph> = {
  rocket: IconRocket,
  star: IconStar,
  heart: IconHeart,
  sparkle: IconSparkle,
  "light-bulb": IconLightBulb,
  target: IconTarget,
  trophy: IconTrophy,
  megaphone: IconMegaphone,
  analytics: IconAnalytics,
  coins: IconCoins,
  buildings: IconBuildings,
  globe: IconGlobe,
  home: IconHome,
  book: IconBook,
  code: IconCode,
  brush: IconBrush,
  video: IconVideo,
  archive: IconArchive,
  package: IconPackage,
  lock: IconLock,
};

/** A teamspace's sidebar glyph, matching web's `SpaceIcon` (or lock/users by default). */
export function spaceIconOf(teamspace: Pick<DriveTeamspace, "icon" | "private">) {
  if (teamspace.icon && teamspace.icon in SPACE_ICONS) {
    return (SPACE_ICONS[teamspace.icon] ?? IconUsers) satisfies Glyph;
  }
  return (teamspace.private ? IconLock : IconUsers) satisfies Glyph;
}
