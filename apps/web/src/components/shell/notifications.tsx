// In-app notifications (ADR 0021): a bell in the sidebar's footer with your unread count, opening
// the list: assigned to you, @mentioned in a note, a customer replied, an SLA at risk or breached.
// Picking one marks it read and opens its conversation in the inbox's list.
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Dialog } from "react-aria-components/Dialog";
import { IconBell } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { ListBox, ListBoxItem } from "@/components/ui/list-box";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { useAssignees } from "@/hooks/use-conversation.ts";
import { useMarkNotificationsRead, useNotifications } from "@/hooks/use-notifications.ts";
import type { Notification } from "@/lib/types.ts";
import { messageTime } from "../conversation/message.tsx";

/** Past this, the badge says 99+. */
const MAX_COUNT = 99;

export function Notifications() {
  const { notifications, unread, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useNotifications();
  const markRead = useMarkNotificationsRead();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const label = unread ? `Notifications, ${unread} unread` : "Notifications";

  const openOne = (n: Notification) => {
    if (!n.readAt) markRead.mutate({ ids: [n.id] });
    setOpen(false);
    const threadId = n.threadId;
    if (!threadId) return;
    // In its inbox's list of every conversation, where it is whatever its status.
    void (n.mailboxId
      ? router.navigate({
          to: "/inbox/$threadId",
          params: { threadId },
          search: { mailbox: n.mailboxId, view: "all" },
        })
      : router.navigate({ to: "/all/$threadId", params: { threadId } }));
  };

  return (
    <PopoverTrigger isOpen={open} onOpenChange={setOpen}>
      <TooltipTrigger delay={400}>
        <Button intent="plain" size="sq-xs" aria-label={label} className="relative">
          <IconBell />
          {unread > 0 && (
            // Over the bell's top right, out of the flow so the footer doesn't shift.
            <span className="pointer-events-none absolute -end-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-xs leading-none text-primary-foreground tabular-nums">
              {unread > MAX_COUNT ? `${MAX_COUNT}+` : unread}
            </span>
          )}
        </Button>
        <Tooltip>Notifications</Tooltip>
      </TooltipTrigger>
      <Popover placement="top end" className="w-80 max-w-[calc(100vw-2rem)]">
        <Dialog aria-label="Notifications" className="flex max-h-[28rem] flex-col outline-hidden">
          <header className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <span className="text-sm">Notifications</span>
            <Button
              intent="plain"
              size="sm"
              isDisabled={unread === 0}
              onPress={() => markRead.mutate({})}
              className="-me-2"
            >
              Mark all read
            </Button>
          </header>
          {notifications.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              Nothing yet. You'll hear here when you're assigned or mentioned.
            </p>
          ) : (
            <ListBox
              aria-label="Notifications"
              items={notifications}
              selectionMode="none"
              onAction={(key) => {
                const n = notifications.find((x) => x.id === key);
                if (n) openOne(n);
              }}
              className="max-h-none min-h-0 flex-1 rounded-none border-0"
            >
              {(n) => (
                <ListBoxItem id={n.id} textValue={n.subject || "(no subject)"}>
                  <Row notification={n} />
                </ListBoxItem>
              )}
            </ListBox>
          )}
          {hasNextPage && (
            <div className="border-t p-1">
              <Button
                intent="plain"
                size="sm"
                className="w-full"
                isPending={isFetchingNextPage}
                onPress={() => void fetchNextPage()}
              >
                Show older
              </Button>
            </div>
          )}
        </Dialog>
      </Popover>
    </PopoverTrigger>
  );
}

function Row({ notification: n }: { notification: Notification }) {
  const { data: assignees = [] } = useAssignees(n.mailboxId ?? undefined);
  const person = assignees.find((a) => a.memberId === n.actorMemberId);
  const actor = person ? person.name || person.email : undefined;
  return (
    <div className="col-span-full flex min-w-0 items-start gap-2 py-0.5">
      {/* Unread: a primary dot; read: the same space, so the text lines up. */}
      <span
        aria-label={n.readAt ? undefined : "Unread"}
        className={`mt-1.5 size-1.5 shrink-0 rounded-full ${n.readAt ? "" : "bg-primary"}`}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm">{describe(n, actor)}</span>
          <time
            dateTime={n.createdAt}
            className="shrink-0 text-xs text-subtle-foreground tabular-nums"
          >
            {messageTime(n.createdAt)}
          </time>
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {n.subject || "(no subject)"}
        </span>
      </div>
    </div>
  );
}

function describe(n: Notification, actor: string | undefined) {
  switch (n.kind) {
    case "assigned":
      return actor ? `${actor} assigned you` : "Assigned to you";
    case "mention":
      return actor ? `${actor} mentioned you` : "You were mentioned";
    case "customer_reply":
      return "The customer replied";
    case "sla_at_risk":
      return "Due soon";
    case "sla_breached":
      return "Overdue";
    default:
      return "Activity";
  }
}
