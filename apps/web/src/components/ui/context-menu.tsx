import { Menu as MenuRoot } from "@ui-sdk/react/menu";
import {
  useEffect,
  useSyncExternalStore,
  type ComponentType,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { IconArrowUpRight, IconLink, IconCopy } from "@/components/icons/central";
import { desktop } from "@/lib/desktop.ts";
import { Menu, MenuItem, MenuLabel, MenuSeparator, MenuSubMenu } from "./menu";
import { appToast } from "./toast";

type Icon = ComponentType<{ className?: string; "data-slot"?: string }>;

export interface ContextMenuAction {
  /** Required: every menu item leads with an icon (DESIGN.md, "Menus"). */
  icon: Icon;
  label: string;
  onAction: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export interface ContextMenuSubmenu {
  icon: Icon;
  label: string;
  items: ContextMenuEntry[];
  disabled?: boolean;
}

/** A row, a row that opens more, or a separator. Falsy entries are skipped, for `cond && item`. */
export type ContextMenuEntry =
  | ContextMenuAction
  | ContextMenuSubmenu
  | "separator"
  | ""
  | null
  | false
  | undefined;

interface Open {
  id: number;
  x: number;
  y: number;
  entries: ContextMenuEntry[];
  label: string;
}

let current: Open | null = null;
let ids = 0;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

function tidy(entries: ContextMenuEntry[]) {
  const out: (ContextMenuAction | ContextMenuSubmenu | "separator")[] = [];
  for (const entry of entries) {
    if (!entry) continue;
    if (entry === "separator" && (out.length === 0 || out.at(-1) === "separator")) continue;
    out.push(entry);
  }
  while (out.at(-1) === "separator") out.pop();
  return out;
}

const hasItems = (entries: ContextMenuEntry[]) => tidy(entries).length > 0;

/** Opens a context menu at a point in the window, in place of any that is open. */
export function openContextMenu(
  at: { x: number; y: number },
  entries: ContextMenuEntry[],
  options: { label?: string } = {},
) {
  if (!hasItems(entries)) return false;
  current = {
    id: ++ids,
    x: at.x,
    y: at.y,
    entries,
    label: options.label ?? "Actions",
  };
  emit();
  return true;
}

function closeContextMenu() {
  if (!current) return;
  current = null;
  emit();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

function pointOf(event: MouseEvent | ReactMouseEvent, target: Element) {
  const fromKeys = event.button !== 2 && event.clientX === 0 && event.clientY === 0;
  if (!fromKeys) return { x: event.clientX, y: event.clientY };
  const rect = target.getBoundingClientRect();
  return { x: rect.left + 8, y: rect.top + Math.min(rect.height, 32) };
}

/** An element from any frame: a same-origin frame's nodes fail `instanceof` the window's `Element`. */
export function asElement(target: EventTarget | null) {
  const node = target as Node | null;
  return node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : null;
}

/** Text fields keep the system's own menu: Cut, Copy, Paste and spelling. */
export function isEditable(target: EventTarget | null) {
  const field = asElement(target)?.closest("input, textarea, select, [contenteditable]");
  if (!field) return false;
  if (field.localName === "input") {
    return !["button", "checkbox", "radio", "range", "color", "file", "submit", "reset"].includes(
      (field as HTMLInputElement).type,
    );
  }
  if (field.hasAttribute("contenteditable")) return (field as HTMLElement).isContentEditable;
  return true;
}

/**
 * Gives an element a context menu: spread the result on it. `menu` reads the element that was
 * right-clicked (inside this one) and returns its rows, after Copy for text selected in it and
 * Open link and Copy link on a link out of the app (unless the rows have their own); no rows
 * leaves the event to the areas
 * around it, and the app's fallback after them. A menu an inner area opened wins, and a
 * right-click in a portal (a dialog the element opened) is not the element's.
 */
export function contextMenuProps(
  menu: (target: Element) => ContextMenuEntry[] | null | undefined,
  label?: string | ((target: Element) => string),
) {
  return {
    onContextMenu: (event: ReactMouseEvent) => {
      if (event.defaultPrevented || isEditable(event.target)) return;
      const target = event.target as Element;
      if (!event.currentTarget.contains(target)) return;
      const own = menu(target);
      if (!own || !hasItems(own)) return;
      const entries = withShared(own, target, event.currentTarget);
      event.preventDefault();
      openContextMenu(pointOf(event, target), entries, {
        label: typeof label === "function" ? label(target) : label,
      });
    },
  };
}

/** `contextMenuProps` on a wrapper that takes no room (`display: contents`). */
export function ContextMenuArea(props: {
  menu: (target: Element) => ContextMenuEntry[] | null | undefined;
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={props.className ?? "contents"} {...contextMenuProps(props.menu, props.label)}>
      {props.children}
    </div>
  );
}

function copy(text: string, what: string) {
  void navigator.clipboard.writeText(text).catch(() => appToast.error(`${what} was not copied`));
}

function openLink(url: URL) {
  if (url.origin === window.location.origin) window.location.assign(url.href);
  else if (desktop.isDesktop) desktop.openOutside(url.href);
  else window.open(url.href, "_blank", "noopener,noreferrer");
}

function linkEntries(target: Element, view: Window) {
  const anchor = target.closest("a[href]");
  let link: URL | null = null;
  if (anchor) {
    try {
      link = new URL(anchor.getAttribute("href") ?? "", view.location.href);
    } catch {
      link = null;
    }
  }
  const outside = link && link.origin !== window.location.origin ? link : null;
  const mail = outside?.protocol === "mailto:" ? outside.pathname : null;
  return [
    outside && { icon: IconArrowUpRight, label: "Open link", onAction: () => openLink(outside) },
    outside &&
      (mail
        ? { icon: IconCopy, label: "Copy address", onAction: () => copy(mail, "Address") }
        : { icon: IconLink, label: "Copy link", onAction: () => copy(outside.href, "Link") }),
  ] satisfies ContextMenuEntry[];
}

function selectionCopy(view: Window, within?: Element) {
  const selection = view.getSelection();
  const text = selection?.toString() ?? "";
  if (!selection?.rangeCount || !text.trim()) return null;
  if (within && !within.contains(selection.getRangeAt(0).commonAncestorContainer)) return null;
  return { icon: IconCopy, label: "Copy", onAction: () => copy(text, "Text") };
}

function fallbackEntries(target: Element, view: Window) {
  return [
    selectionCopy(view),
    "separator",
    ...linkEntries(target, view),
  ] satisfies ContextMenuEntry[];
}

function withShared(own: ContextMenuEntry[], target: Element, area: Element) {
  const taken = new Set(tidy(own).map((entry) => (entry === "separator" ? "" : entry.label)));
  const shared = [selectionCopy(window, area), ...linkEntries(target, window)].filter(
    (entry) => entry && !taken.has(entry.label),
  );
  return [...shared, "separator", ...own] satisfies ContextMenuEntry[];
}

function onFallback(event: MouseEvent, offset?: { x: number; y: number }) {
  if (event.defaultPrevented || isEditable(event.target)) return;
  event.preventDefault();
  const target = asElement(event.target);
  if (!target) return;
  const view = target.ownerDocument.defaultView ?? window;
  const at = pointOf(event, target);
  openContextMenu(
    offset ? { x: at.x + offset.x, y: at.y + offset.y } : at,
    fallbackEntries(target, view),
  );
}

/**
 * The fallback for a same-origin frame (a message's HTML): its right-clicks show the app's menu,
 * placed in the window, not the frame. Returns the way to stop.
 */
export function routeFrameContextMenu(frame: HTMLIFrameElement) {
  const doc = frame.contentDocument;
  if (!doc) return () => {};
  const listener = (event: MouseEvent) => {
    const rect = frame.getBoundingClientRect();
    onFallback(event, { x: rect.left, y: rect.top });
  };
  doc.addEventListener("contextmenu", listener);
  return () => doc.removeEventListener("contextmenu", listener);
}

function Entries({ entries }: { entries: ContextMenuEntry[] }) {
  return tidy(entries).map((entry, index) => {
    if (entry === "separator") return <MenuSeparator key={`separator-${index}`} />;
    const { icon: Icon } = entry;
    if ("items" in entry) {
      return (
        <MenuSubMenu key={entry.label}>
          <MenuItem textValue={entry.label} isDisabled={entry.disabled}>
            <Icon data-slot="icon" />
            <MenuLabel>{entry.label}</MenuLabel>
          </MenuItem>
          <Menu aria-label={entry.label}>
            <Entries entries={entry.items} />
          </Menu>
        </MenuSubMenu>
      );
    }
    return (
      <MenuItem
        key={entry.label}
        textValue={entry.label}
        intent={entry.danger ? "danger" : undefined}
        isDisabled={entry.disabled}
        onAction={entry.onAction}
      >
        <Icon data-slot="icon" />
        <MenuLabel>{entry.label}</MenuLabel>
      </MenuItem>
    );
  });
}

/**
 * The app's one context menu, mounted once at the root, and the guard that keeps the system's
 * menu away: a right-click no area claimed gets the fallback rows, or nothing.
 */
export function ContextMenuHost() {
  const open = useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
  useEffect(() => {
    const listener = (event: MouseEvent) => onFallback(event);
    document.addEventListener("contextmenu", listener);
    return () => document.removeEventListener("contextmenu", listener);
  }, []);
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement;
    const frame = requestAnimationFrame(() => {
      document.querySelector<HTMLElement>("[role=menu][data-open]")?.focus();
    });
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.activeElement?.closest("[role=menu]")) return;
      closeContextMenu();
    };
    document.addEventListener("keydown", escape);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", escape);
      if (before instanceof HTMLElement && document.contains(before)) {
        before.focus({ preventScroll: true });
      }
    };
  }, [open]);
  if (!open) return null;
  return (
    <MenuRoot
      key={open.id}
      defaultOpen
      onOpenChange={(next) => {
        if (!next) closeContextMenu();
      }}
    >
      <Menu
        aria-label={open.label}
        placement="bottom start"
        popover={{ anchor: { x: open.x, y: open.y }, offset: 2, collisionPadding: 8 }}
      >
        <Entries entries={open.entries} />
      </Menu>
    </MenuRoot>
  );
}
