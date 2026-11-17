// In-app notifications: the bell in the sidebar's footer, with your unread count, toggles a panel
// the window's height that slides out from the sidebar's edge and floats over the page (Figma:
// Omni, node 64:2). It shares the thread list's header height, header actions and fluid hover;
// its rows are two lines beside who did it, so they read as notifications, not mail.
// All or Unread; picking one marks it read and opens its conversation, or People in settings
// for a new teammate. Escape or a press outside closes it.
import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState, type Key, type ReactNode } from "react";
import { Collection } from "react-aria-components/Collection";
import { GridListLoadMoreItem } from "react-aria-components/GridList";
import { Skeleton, SkeletonBox } from "skullet/react";
import { EmptyState } from "@/components/empty/empty-state";
import { IconInbox } from "@/components/icons/sidebar";
import {
  IconCircleAlert,
  IconClock3,
  IconMail,
  IconMailOpen,
  IconSliders,
  IconX,
} from "@/components/icons/central";
import { rowTime } from "@/components/inbox/conversation-meta";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { FluidHoverHighlight } from "@/components/ui/fluid-hover-highlight";
import { GridList, GridListItem } from "@/components/ui/grid-list";
import { useSidebar } from "@/components/ui/sidebar";
import { Tab, TabList, TabPanel, Tabs } from "@/components/ui/tabs";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { useFluidHoverList } from "@/hooks/use-fluid-hover-list";
import { useMarkNotificationsRead, useNotifications } from "@/hooks/use-notifications.ts";
import { useWhenIdle } from "@/hooks/use-when-idle.ts";
import {
  closeNotificationsPanel,
  toggleNotificationsPanel,
  useNotificationsPanel,
} from "@/hooks/use-notifications-panel.ts";
import { useOpenSettings } from "@/hooks/use-settings.ts";
import { useFilePlace } from "@/hooks/use-storage.ts";
import {
  actorName,
  commentTarget,
  notificationParts,
  notificationSubject,
  notificationTitle,
} from "@/lib/notification-text.ts";
import type { Notification } from "@/lib/types.ts";
import { pictureUrl } from "@/lib/urls.ts";
import { CountBadge } from "./count-badge";
import { TitleBarSpace } from "./title-bar";
import { useWorkspaceSlug } from "@/hooks/use-workspaces.ts";

/** Notifications, drawn as an inbox: opens and closes the panel, and wears your unread count. */
export function NotificationsButton() {
  const { unread } = useNotifications();
  const open = useNotificationsPanel();
  const { isMobile, setIsOpenOnMobile } = useSidebar();
  return (
    <TooltipTrigger delay={400}>
      <Button
        intent="ghost"
        size="sq-sm"
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        aria-controls="notifications-panel"
        data-notifications-toggle
        onPress={() => {
          // On a phone the bell sits in the sidebar's sheet, which would cover the panel.
          if (isMobile) setIsOpenOnMobile(false);
          toggleNotificationsPanel();
        }}
        className="relative"
      >
        <IconInbox />
        {/* Over the bell's top right, out of the flow so the footer doesn't shift. */}
        <CountBadge count={unread} className="pointer-events-none absolute -end-2 -top-2" />
      </Button>
      <Tooltip>Notifications</Tooltip>
    </TooltipTrigger>
  );
}

type View = "all" | "unread";

/** The panel. Mount once in the shell, beside the sidebar. */
export function NotificationsPanel() {
  const open = useNotificationsPanel();
  const { open: sidebarOpen, isMobile } = useSidebar();
  const titleBarOver = !sidebarOpen && !isMobile;
  const { unread } = useNotifications();
  const markRead = useMarkNotificationsRead();
  const openSettings = useOpenSettings();
  const [view, setView] = useState<View>("all");
  const panel = useRef<HTMLElement>(null);
  // The closed panel's list loads once startup is over, not during it, and at once if opened.
  const listed = useWhenIdle(open);

  // Escape and a press anywhere outside close it; the bell toggles it on its own.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) closeNotificationsPanel();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target || panel.current?.contains(target)) return;
      if (target.closest("[data-notifications-toggle]")) return;
      closeNotificationsPanel();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  // Focus moves into it when it opens, so the keyboard can walk the list at once.
  useEffect(() => {
    if (open) panel.current?.focus({ preventScroll: true });
  }, [open]);

  return (
    // The clip starts at the sidebar's edge, so the panel slides out from under it.
    <div
      className={`pointer-events-none fixed inset-y-0 end-0 z-30 overflow-hidden ${
        sidebarOpen && !isMobile ? "start-(--sidebar-width)" : "start-0"
      }`}
    >
      <aside
        ref={panel}
        id="notifications-panel"
        aria-label="Notifications"
        tabIndex={-1}
        inert={!open}
        className={`pointer-events-auto flex h-full w-108 max-w-full flex-col border-e bg-background shadow-overlay outline-hidden transition-[translate,opacity,visibility] duration-200 ease-out motion-reduce:transition-[opacity,visibility] ${
          open
            ? "visible translate-x-0 opacity-100"
            : "invisible -translate-x-full opacity-0 motion-reduce:translate-x-0"
        }`}
      >
        {/* The thread list's header height and insets: the title 20px in, actions 10px from the
            edge. No rule under it: the tabs' line closes the header. */}
        <header className="flex h-12 shrink-0 items-center gap-2 ps-5 pe-2.5">
          {/* With the sidebar closed the panel starts at the window's edge, under the title bar. */}
          {titleBarOver && <TitleBarSpace inset={20} afterIsland={false} />}
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium">Notifications</h2>
          <div className="flex items-center gap-1">
            <HeaderAction
              label="Mark all read"
              isDisabled={unread === 0}
              onPress={() => markRead.mutate({})}
            >
              <IconMailOpen />
            </HeaderAction>
            <HeaderAction
              label="Notification settings"
              onPress={() => {
                closeNotificationsPanel();
                openSettings("notifications");
              }}
            >
              <IconSliders />
            </HeaderAction>
            {/* A phone shows the panel full width, with no outside to press: it closes here. */}
            {isMobile && (
              <HeaderAction label="Close" onPress={closeNotificationsPanel}>
                <IconX />
              </HeaderAction>
            )}
          </div>
        </header>
        <Tabs
          selectedKey={view}
          onSelectionChange={(key: Key) => setView(key as View)}
          className="min-h-0 w-full flex-1 gap-0"
        >
          {/* 28px tabs, 2px up into the header's bottom space, so they sit under its title and
              centre on the sidebar's search field across the page. */}
          <TabList
            aria-label="Show"
            className="-mt-0.5 shrink-0 px-5 [--tab-list-pb:--spacing(2)] [--tab-list-tab-y:--spacing(0.5)]"
          >
            <Tab id="all">All</Tab>
            <Tab id="unread" className="gap-1.5">
              Unread
              <CountBadge count={unread} />
            </Tab>
          </TabList>
          <TabPanel id="all" className="flex min-h-0 flex-col">
            {listed && <NotificationList unread={false} />}
          </TabPanel>
          <TabPanel id="unread" className="flex min-h-0 flex-col">
            {listed && <NotificationList unread />}
          </TabPanel>
        </Tabs>
      </aside>
    </div>
  );
}

/** An icon action in the header: the thread list's own, the reader's toolbar size. */
function HeaderAction(props: {
  label: string;
  isDisabled?: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <TooltipTrigger delay={400}>
      <Button
        intent="ghost"
        size="sq-sm"
        aria-label={props.label}
        isDisabled={props.isDisabled}
        onPress={props.onPress}
      >
        {props.children}
      </Button>
      <Tooltip>{props.label}</Tooltip>
    </TooltipTrigger>
  );
}

function NotificationList({ unread }: { unread: boolean }) {
  const { notifications, isPending, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useNotifications({ unread });
  const markRead = useMarkNotificationsRead();
  const router = useRouter();
  const workspace = useWorkspaceSlug();
  const openSettings = useOpenSettings();
  const filePlace = useFilePlace();
  const hover = useFluidHoverList({
    itemSelector: "[role='row']",
    highlightedSelector: "[data-focus-visible]",
  });

  const openOne = (n: Notification) => {
    if (!n.readAt) markRead.mutate({ ids: [n.id] });
    closeNotificationsPanel();
    const comment = commentTarget(n);
    if (comment) {
      // The file's folder, with its comments open beside it; where the file is now, since it may
      // have moved after the comment (where it was then if it can't be read).
      void filePlace(comment.nodeId).then((now) => {
        const { space, folderId } = now ?? comment;
        const place = space === "personal" ? "my" : "shared";
        const search = { comments: comment.nodeId };
        return folderId
          ? router.navigate({
              to: `/$workspace/files/${place}/$folderId`,
              params: { workspace, folderId },
              search,
            })
          : router.navigate({ to: `/$workspace/files/${place}/`, params: { workspace }, search });
      });
      return;
    }
    const threadId = n.threadId;
    if (!threadId) {
      if (n.kind === "member_joined") openSettings("people");
      return;
    }
    // In its inbox's list of every conversation, where it is whatever its status.
    void (n.mailboxId
      ? router.navigate({
          to: "/$workspace/mail/inbox/$threadId",
          params: { workspace, threadId },
          search: { mailbox: n.mailboxId, view: "all" },
        })
      : router.navigate({ to: "/$workspace/mail/all/$threadId", params: { workspace, threadId } }));
  };

  if (isPending) {
    return (
      <Skeleton
        loading
        label="Loading notifications"
        skeleton={<RowBones />}
        className="min-h-0 flex-1 overflow-hidden"
      >
        {null}
      </Skeleton>
    );
  }
  if (notifications.length === 0) {
    return (
      <EmptyState
        figure="drawer"
        title="No notifications"
        description="Your inbox looks very clean today"
      />
    );
  }
  return (
    <div className="@container relative flex min-h-0 flex-1 flex-col" {...hover.containerProps}>
      <FluidHoverHighlight {...hover.highlightProps} />
      <GridList
        aria-label={unread ? "Unread notifications" : "Notifications"}
        // Transparent, as the thread list: the highlight sits under the rows.
        className="min-h-0 flex-1 overflow-y-auto overscroll-none bg-transparent"
        selectionMode="none"
        onAction={(key) => {
          const n = notifications.find((x) => x.id === key);
          if (n) openOne(n);
        }}
      >
        <Collection items={notifications}>{(n) => <NotificationRow notification={n} />}</Collection>
        <GridListLoadMoreItem
          onLoadMore={hasNextPage ? () => void fetchNextPage() : undefined}
          isLoading={isFetchingNextPage}
          scrollOffset={3}
        />
      </GridList>
    </div>
  );
}

/**
 * Two lines beside who did it: "Bea Klein assigned you", then what it is about; the unread dot
 * and the time at the end of the first line. 20px all round, ruled like the thread list.
 */
function NotificationRow({ notification: n }: { notification: Notification }) {
  const unread = !n.readAt;
  const { actor, action } = notificationParts(n);
  const subject = notificationSubject(n);
  return (
    <GridListItem
      id={n.id}
      textValue={notificationTitle(n)}
      className="items-center gap-3 border-b p-5"
    >
      <Lead notification={n} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm">
            {actor && (
              <span className={unread ? "text-foreground" : "text-muted-foreground"}>{actor} </span>
            )}
            <span className={!actor && unread ? "text-foreground" : "text-muted-foreground"}>
              {action}
            </span>
          </span>
          {/* Unread: a primary dot just before the time, which keeps the row's end. */}
          {unread && (
            <span aria-label="Unread" className="size-2 shrink-0 rounded-full bg-primary" />
          )}
          <time
            dateTime={n.createdAt}
            className="shrink-0 text-xs text-subtle-foreground tabular-nums"
          >
            {rowTime(n.createdAt)}
          </time>
        </span>
        {subject && <span className="truncate text-sm text-subtle-foreground">{subject}</span>}
      </span>
    </GridListItem>
  );
}

/** A squircle: 28px with 6px corners. */
const AVATAR =
  "shrink-0 bg-accent text-foreground outline-0 mix-blend-multiply [--avatar-radius:var(--radius-lg)] [--avatar-size:--spacing(7)]";

/** Who did it, by their picture; what happened, by a glyph, when no one did. */
function Lead({ notification: n }: { notification: Notification }) {
  const name = actorName(n);
  if (name) {
    return (
      <Avatar
        isSquare
        src={pictureUrl(n.actor?.image)}
        initials={name.slice(0, 1).toUpperCase()}
        className={AVATAR}
      />
    );
  }
  const Glyph =
    n.kind === "sla_breached" ? IconCircleAlert : n.kind === "sla_at_risk" ? IconClock3 : IconMail;
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent text-muted-foreground mix-blend-multiply">
      <Glyph aria-hidden className="size-icon" />
    </span>
  );
}

/** The rows while they load: the thread list's bones on the same grid. */
function RowBones() {
  return Array.from({ length: 12 }, (_, i) => (
    <div key={i} className="flex items-center gap-3 border-b p-5">
      <SkeletonBox width={28} height={28} radius="var(--radius-lg)" />
      <span className="flex min-w-0 flex-1 flex-col gap-2">
        <SkeletonBox width={`${55 + ((i * 23) % 35)}%`} height={10} />
        <SkeletonBox width={`${35 + ((i * 17) % 30)}%`} height={8} />
      </span>
    </div>
  ));
}
