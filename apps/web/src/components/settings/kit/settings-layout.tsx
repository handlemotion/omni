// Settings pages, ported from transitive's settings kit (`components/settings/kit`) onto our
// tokens: a page is a title over sections; a section is a muted title over groups; a group is a
// raised card of rows divided by hairlines.
//
// Geometry: a section's title sits on the rows' text axis (16px in). It gets 32px from the group
// above and 8px to its own, so it reads as the label of what follows.
import { IconInfo } from "@/components/icons/lucide";
import { cn } from "cn";
import type { ReactNode } from "react";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "react-aria-components/Button";
import { SettingsIllustration } from "./settings-illustrations";

/** The anchor of a section, from its title; settings search names sections by it. */
export function settingsSectionId(title: string): string {
  return `settings-${title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "")}`;
}

export function SettingsPageHeader({
  actions,
  avatar,
  title,
}: {
  actions?: ReactNode;
  /** The picture of what the page is about, before the title. */
  avatar?: ReactNode;
  title: string;
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 pb-6">
      <div className="flex min-w-0 items-center gap-3">
        {avatar}
        <h2 className="truncate text-lg font-medium text-foreground">{title}</h2>
      </div>
      {actions}
    </header>
  );
}

/** The page's stack of sections. */
export function SettingsSections({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("flex flex-col gap-8", className)}>{children}</div>;
}

/** A titled set of groups; a section can hold more than one group. */
export function SettingsSection({
  actions,
  children,
  description,
  info,
  title,
}: {
  /** Controls that act on the whole section, on the title's line. */
  actions?: ReactNode;
  children: ReactNode;
  description?: ReactNode;
  /** A short explanation behind an info icon next to the title. */
  info?: string;
  title: string;
}) {
  return (
    <section className="flex min-w-0 scroll-mt-6 flex-col gap-2" id={settingsSectionId(title)}>
      <div className="flex min-h-7 items-center justify-between gap-3 px-4">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-sm text-muted-foreground">
            {title}
            {info && (
              <TooltipTrigger delay={300}>
                <Button
                  aria-label={info}
                  className="inline-flex rounded-full text-subtle-foreground outline-hidden hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <IconInfo className="size-3.5" />
                </Button>
                <Tooltip>{info}</Tooltip>
              </TooltipTrigger>
            )}
          </h3>
          {description && (
            <p className="mt-0.5 text-xs/4 text-pretty text-subtle-foreground">{description}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      <div className="flex min-w-0 flex-col gap-2.5">{children}</div>
    </section>
  );
}

/** A flat card of rows: outlined, divided by hairlines, no shadow. */
export function SettingsGroup({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="settings-group"
      className={cn(
        "flex min-w-0 flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-background",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Free content inside a group: a note, an error, a chart. */
export function SettingsGroupBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("px-4 py-3 text-xs/4 text-muted-foreground", className)}>{children}</div>
  );
}

/**
 * A section with nothing to show, in place of its group: the same card, always 240px tall, so no
 * section disappears and every empty one reads alike. `empty`: nothing here yet (what would be
 * here, and how to add it). `restricted`: there is something, but not for you (who can see it).
 * A hairline figure says which at a glance: by default a tray for empty, a padlock for restricted.
 */
export function SettingsEmptyState({
  action,
  description,
  title,
  variant = "empty",
}: {
  /** One button that fills it: "Add a passkey". Never on `restricted`. */
  action?: ReactNode;
  description: string;
  title: string;
  variant?: "empty" | "restricted";
}) {
  return (
    <SettingsGroup>
      {/* 24px more below than above: the figure, title and line sit a little above the middle,
          where a centred block looks centred (optical). */}
      <div
        data-slot="settings-empty-state"
        data-variant={variant}
        className="flex min-h-60 w-full flex-col items-center justify-center px-6 pt-6 pb-12 text-center"
      >
        <SettingsIllustration name={variant === "restricted" ? "lock" : "tray"} className="mb-4" />
        <p className="text-sm/4 font-semibold text-pretty text-foreground">{title}</p>
        <p className="mt-1 max-w-90 text-xs/4 text-pretty text-muted-foreground">{description}</p>
        {action && variant === "empty" && <div className="mt-4">{action}</div>}
      </div>
    </SettingsGroup>
  );
}
