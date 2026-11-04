// A navigation list whose rows pick what a panel beside it shows (settings' pages): grouped
// under small labels, one row current. React Aria's ListBox does the keyboard work (arrows,
// typeahead, sections); the rows look like the app sidebar's (`SidebarItem`): 32px, 8px in,
// a 15px muted icon 10px before the label, the current row on the `accent` fill. One hover
// highlight springs between rows, as in the sidebar.
import { Header } from "react-aria-components/Header";
import {
  ListBox,
  ListBoxItem,
  ListBoxSection,
  type ListBoxItemProps,
  type ListBoxProps,
  type ListBoxSectionProps,
} from "react-aria-components/ListBox";
import { cn } from "cn";
import { cx } from "@/lib/primitive";
import { useFluidHoverList } from "@/hooks/use-fluid-hover-list";
import { FluidHoverHighlight } from "./fluid-hover-highlight";

export function NavList<T extends object>({ className, ...props }: ListBoxProps<T>) {
  const hover = useFluidHoverList({
    itemSelector: "[data-slot='nav-list-item']",
    highlightedSelector: "[data-focus-visible]",
  });
  return (
    <div className="relative flex min-h-0 flex-col" {...hover.containerProps}>
      <FluidHoverHighlight {...hover.highlightProps} />
      <ListBox
        selectionMode="single"
        disallowEmptySelection
        layout="stack"
        {...props}
        data-slot="nav-list"
        className={cx("flex flex-col gap-3 outline-hidden", className)}
      />
    </div>
  );
}

export interface NavListSectionProps<T> extends Omit<ListBoxSectionProps<T>, "children"> {
  label?: string;
  children: React.ReactNode;
}

/** A group of rows under a label, aligned with the app sidebar's group labels. */
export function NavListSection<T extends object>({
  label,
  className,
  children,
  ...props
}: NavListSectionProps<T>) {
  return (
    <ListBoxSection {...props} className={cn("flex flex-col gap-y-0.5", className)}>
      {label && (
        <Header className="flex h-8 shrink-0 items-center px-2.25 text-xs text-subtle-foreground">
          {label}
        </Header>
      )}
      {children}
    </ListBoxSection>
  );
}

export function NavListItem<T extends object>({ className, ...props }: ListBoxItemProps<T>) {
  return (
    <ListBoxItem
      {...props}
      data-slot="nav-list-item"
      className={cx(
        "relative flex h-8 w-full min-w-0 cursor-default items-center gap-2.5 rounded-lg px-2 text-start text-sm text-foreground outline-hidden",
        "*:[svg]:size-icon *:[svg]:shrink-0 *:[svg]:text-muted-foreground hover:*:[svg]:text-foreground",
        "selected:bg-accent selected:*:[svg]:text-foreground",
        "focus-visible:inset-ring focus-visible:inset-ring-ring disabled:opacity-50",
        className,
      )}
    />
  );
}

/** A row's label: one line, cut with an ellipsis. */
export function NavListLabel({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("min-w-0 truncate", className)} {...props} />;
}
