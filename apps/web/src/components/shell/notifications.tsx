import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState, type Key, type ReactNode } from "react";
import { Collection } from "react-aria-components/Collection";
import { GridListLoadMoreItem } from "react-aria-components/GridList";
import { Skeleton, SkeletonBox } from "skullet/react";
import { EmptyState } from "@/components/empty/empty-state";
import { IconInbox } from "@/components/icons/sidebar";
import {
  IconArrowUpRight,
  IconCheck,
  IconCircleAlert,
  IconClock3,
  IconMail,
  IconMailOpen,
  IconSliders,
  IconX,
} from "@/components/icons/central";
import { rowTime } from "@/components/inbox/conversation-meta";
import { Avatar } from "@/components/ui/avatar";
import { Button, PageBarActions } from "@/components/ui/button";
import { contextMenuProps } from "@/components/ui/context-menu";
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
          if (isMobile) setIsOpenOnMobile(false);
          toggleNotificationsPanel();
        }}
        className="relative"
      >
        <IconInbox />
        <CountBadge count={unread} className="pointer-events-none absolute -end-2 -top-2" />
      </Button>
      <Tooltip>Notifications</Tooltip>
    </TooltipTrigger>
  );
}

type View = "all" | "unread";

/** The panel, at the window's right edge under its button. Mount once in the shell. */
export function NotificationsPanel() {
  const open = useNotificationsPanel();
  const { isMobile } = useSidebar();
  const { unread } = useNotifications();
  const markRead = useMarkNotificationsRead();
  const openSettings = useOpenSettings();
  const [view, setView] = useState<View>("all");
  const panel = useRef<HTMLElement>(null);
  const listed = useWhenIdle(open);

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

  useEffect(() => {
    if (open) panel.current?.focus({ preventScroll: true });
  }, [open]);

  return (
    <div
      className={`pointer-events-none fixed bottom-0 end-0 z-30 flex justify-end overflow-hidden ${
        isMobile ? "start-0 top-0" : "start-0 top-12"
      }`}
    >
      <aside
        ref={panel}
        id="notifications-panel"
        aria-label="Notifications"
        tabIndex={-1}
        inert={!open}
        className={`pointer-events-auto flex h-full w-108 max-w-full flex-col border-s ${isMobile ? "" : "border-t"} bg-background shadow-overlay outline-hidden transition-[translate,opacity,visibility] duration-200 ease-out motion-reduce:transition-[opacity,visibility] ${
          open
            ? "visible translate-x-0 opacity-100"
            : "invisible translate-x-full opacity-0 motion-reduce:translate-x-0"
        }`}
      >
        <header className="flex h-12 shrink-0 items-center gap-2 ps-5 pe-2.5">
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium">Notifications</h2>
          <div className="flex items-center gap-1.5">
            <PageBarActions>
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
              {isMobile && (
                <HeaderAction label="Close" onPress={closeNotificationsPanel}>
                  <IconX />
                </HeaderAction>
              )}
            </PageBarActions>
          </div>
        </header>
        <Tabs
          selectedKey={view}
          onSelectionChange={(key: Key) => setView(key as View)}
          className="min-h-0 w-full flex-1 gap-0"
        >
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
  const menu = contextMenuProps((target) => {
    const key = target.closest("[data-key]")?.getAttribute("data-key");
    const n = notifications.find((x) => x.id === key);
    if (!n) return null;
    return [
      { icon: IconArrowUpRight, label: "Open", onAction: () => openOne(n) },
      !n.readAt && {
        icon: IconMailOpen,
        label: "Mark read",
        onAction: () => markRead.mutate({ ids: [n.id] }),
      },
      { icon: IconCheck, label: "Mark all read", onAction: () => markRead.mutate({}) },
    ];
  }, "Notification actions");
  return (
    <div
      className="@container relative flex min-h-0 flex-1 flex-col"
      {...hover.containerProps}
      {...menu}
    >
      <FluidHoverHighlight {...hover.highlightProps} />
      <GridList
        aria-label={unread ? "Unread notifications" : "Notifications"}
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

const AVATAR =
  "shrink-0 bg-accent text-foreground outline-0 mix-blend-multiply [--avatar-radius:var(--radius-lg)] [--avatar-size:--spacing(7)]";

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
