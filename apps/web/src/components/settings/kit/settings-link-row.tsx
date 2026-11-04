import { IconArrowUpRight, IconChevronRight } from "@/components/icons/lucide";
import { cn } from "cn";
import type { ReactNode } from "react";
import { Button } from "react-aria-components/Button";
import { Link } from "react-aria-components/Link";
import {
  settingsRowClassName,
  settingsRowInteractiveClassName,
  settingsRowTextEndClassName,
  SettingsRowText,
  type SettingsRowIcon,
} from "./settings-row";

const interactiveRowClassName = cn(
  settingsRowClassName,
  settingsRowTextEndClassName,
  settingsRowInteractiveClassName,
);

/**
 * A whole-row target: a page outside the app (`href`, opens a new tab) or a dialog, a page or
 * another settings page (`onPress`). The trailing glyph says which: an arrow for external, a
 * chevron otherwise.
 */
export function SettingsLinkRow({
  href,
  onPress,
  value,
  ...text
}: {
  badge?: ReactNode;
  hint?: ReactNode;
  description?: ReactNode;
  href?: string;
  icon?: SettingsRowIcon;
  label: ReactNode;
  onPress?: () => void;
  /** A short current value shown before the glyph. */
  value?: ReactNode;
}) {
  const children = (
    <>
      <SettingsRowText {...text} />
      {value && (
        <span className="max-w-56 shrink-0 truncate text-sm/4 text-muted-foreground">{value}</span>
      )}
      {href ? (
        <IconArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <IconChevronRight className="size-icon shrink-0 text-muted-foreground" />
      )}
    </>
  );
  return href ? (
    <Link className={interactiveRowClassName} href={href} rel="noreferrer" target="_blank">
      {children}
    </Link>
  ) : (
    <Button className={interactiveRowClassName} onPress={onPress}>
      {children}
    </Button>
  );
}
