import { useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { IconArrowUpRight, IconPencil } from "@/components/icons/central";
import { ContextMenuArea, type ContextMenuEntry } from "@/components/ui/context-menu";
import { useOpenCompose } from "@/hooks/use-compose-pane.ts";

/**
 * Mail's sidebar with its context menu: a right-click on a list (Inbox, Sent, Mine…) opens it or
 * starts a new message; anywhere else in the sidebar, a new message.
 */
export function MailNavMenu({ children }: { children: ReactNode }) {
  const router = useRouter();
  const compose = useOpenCompose();
  const menu = (target: Element) => {
    const row = target.closest("a[data-slot=sidebar-item]");
    const href = row?.getAttribute("href");
    return [
      href && {
        icon: IconArrowUpRight,
        label: "Open",
        onAction: () => void router.navigate({ href }),
      },
      href && "separator",
      { icon: IconPencil, label: "New message", onAction: compose },
    ] satisfies ContextMenuEntry[];
  };
  return (
    <ContextMenuArea menu={menu} label="Mail">
      {children}
    </ContextMenuArea>
  );
}
