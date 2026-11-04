// The settings row (from transitive's kit): text on the left, the control on the right. Typed
// rows (toggle, select, input, button, link, collapsible, value, add, ...) build on it.
//
// Geometry, so every row reads at the same rhythm:
// - Text starts 16px from the card's edge. A control ends 12px from it: its own border and
//   padding carry the rest, so its label sits about as far in as the row's text. A row that ends
//   in text or a glyph (value, chevron) ends 16px in, like it starts.
// - Rows are at least 52px: a 32px control with 10px above and below. A two-line block is the
//   13/16 label, 2px, then the 11/16 description (34px), so neither line is clipped.
// - A leading 15px icon sits 16px in, like text. A 32px avatar is as far from the row's left as
//   from its top (10px), as in the mailbox switcher, so an avatar row starts 10px in.
import { cn } from "cn";
import type { ComponentType, ReactNode } from "react";

export type SettingsRowIcon = ComponentType<{ className?: string }>;

export const settingsRowClassName =
  "flex min-h-13 w-full min-w-0 items-center gap-4 py-2.5 ps-4 pe-3 text-start";

/** For rows that lead with a 32px avatar: 10px in, as far as it sits from the row's top. */
export const settingsRowAvatarClassName = "ps-2.5";

/** For rows whose right side is text or a glyph rather than a control. */
export const settingsRowTextEndClassName = "pe-4";

export const settingsRowLabelClassName = "text-sm/4 text-foreground";

export const settingsRowDescriptionClassName = "truncate text-xs/4 text-muted-foreground";

/** Hover and focus fill for rows that are themselves a target. */
export const settingsRowInteractiveClassName =
  "cursor-default outline-hidden transition-colors duration-100 hover:bg-hover focus-visible:bg-hover";

/** A row's leading icon or avatar, title, badge, description, and footer. */
export function SettingsRowText({
  avatar,
  badge,
  description,
  footer,
  hint,
  htmlFor,
  icon: Icon,
  label,
}: {
  /** A person's picture in place of the icon. */
  avatar?: ReactNode;
  badge?: ReactNode;
  /** A short muted qualifier after the label, in parentheses: a code, "you". */
  hint?: ReactNode;
  description?: ReactNode;
  /** A line below the description, such as a help link. */
  footer?: ReactNode;
  htmlFor?: string;
  icon?: SettingsRowIcon;
  label: ReactNode;
}) {
  const title = (
    <span className={cn(settingsRowLabelClassName, "flex min-w-0 items-center gap-2")}>
      <span className="min-w-0 truncate">
        {label}
        {hint && <span className="text-muted-foreground"> ({hint})</span>}
      </span>
      {badge}
    </span>
  );
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      {avatar ? (
        <span className="flex shrink-0 items-center">{avatar}</span>
      ) : Icon ? (
        <span className="flex size-icon shrink-0 items-center justify-center text-muted-foreground">
          <Icon className="size-icon" />
        </span>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {htmlFor ? (
          <label className="cursor-default" htmlFor={htmlFor}>
            {title}
          </label>
        ) : (
          title
        )}
        {description && <p className={settingsRowDescriptionClassName}>{description}</p>}
        {footer && <div className="mt-1">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * The generic row; use it directly only for a control none of the typed rows fits (two buttons,
 * a badge and a menu).
 */
export function SettingsRow({
  className,
  control,
  ...text
}: Parameters<typeof SettingsRowText>[0] & { className?: string; control?: ReactNode }) {
  return (
    <div
      data-slot="settings-row"
      className={cn(settingsRowClassName, text.avatar && settingsRowAvatarClassName, className)}
    >
      <SettingsRowText {...text} />
      {control && <div className="flex shrink-0 items-center justify-end gap-2">{control}</div>}
    </div>
  );
}
