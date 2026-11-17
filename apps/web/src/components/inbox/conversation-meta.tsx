import { useSyncExternalStore } from "react";
import { IconPaperclip } from "@/components/icons/central";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import type { ConversationStatus, Priority } from "@/lib/types.ts";

export interface ConversationRowInfo {
  /** Shown only on views that mix statuses (Mine, a tag). */
  status?: ConversationStatus | undefined;
  priority: Priority;
  tags: { id: string; name: string }[];
  slaDueAt: string | null;
  hasAttachments: boolean;
  assignee: { name: string; image: string | null } | null;
  lastMessageAt: string;
}

const STATUS_LABELS: Record<ConversationStatus, string> = {
  open: "Open",
  pending: "Pending",
  snoozed: "Snoozed",
  resolved: "Resolved",
};

const clock = (() => {
  let now = Date.now();
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      timer ??= setInterval(() => {
        now = Date.now();
        for (const l of listeners) l();
      }, 60_000);
      return () => {
        listeners.delete(listener);
        if (!listeners.size && timer) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
    get: () => now,
  };
})();

function span(ms: number) {
  const minutes = Math.max(1, Math.floor(Math.abs(ms) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

const AT_RISK_MS = 30 * 60_000;

function SlaTimer({ due }: { due: string }) {
  const now = useSyncExternalStore(clock.subscribe, clock.get);
  const left = new Date(due).getTime() - now;
  if (left < 0) {
    return (
      <Badge intent="danger" isCircle={false} className="tabular-nums" title="SLA breached">
        {span(left)} over
      </Badge>
    );
  }
  if (left <= AT_RISK_MS) {
    return (
      <Badge intent="warning" isCircle={false} className="tabular-nums" title="SLA due soon">
        {span(left)}
      </Badge>
    );
  }
  return (
    <span className="text-xs text-subtle-foreground tabular-nums" title="Next SLA due">
      {span(left)}
    </span>
  );
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** Today: the time. Before: the day. */
export function rowTime(iso: string) {
  const date = new Date(iso);
  return (new Date().toDateString() === date.toDateString() ? TIME : DAY).format(date);
}

export function ConversationMeta({ info }: { info: ConversationRowInfo }) {
  const raised = info.priority === "urgent" || info.priority === "high";
  return (
    <span className="flex shrink-0 items-center gap-2">
      {info.status && (
        <Badge intent="secondary" isCircle={false} className="hidden @xl:inline-flex">
          {STATUS_LABELS[info.status]}
        </Badge>
      )}
      {info.tags.slice(0, 2).map((tag) => (
        <Badge
          key={tag.id}
          intent="outline"
          isCircle={false}
          className="hidden max-w-28 truncate @2xl:inline-flex"
        >
          {tag.name}
        </Badge>
      ))}
      {raised && (
        <Badge intent={info.priority === "urgent" ? "danger" : "warning"} isCircle={false}>
          {info.priority === "urgent" ? "Urgent" : "High"}
        </Badge>
      )}
      {info.slaDueAt && <SlaTimer due={info.slaDueAt} />}
      {info.hasAttachments && (
        <IconPaperclip
          aria-label="Has attachments"
          className="hidden size-3.5 text-subtle-foreground @xl:block"
        />
      )}
      {info.assignee && (
        <Avatar
          src={info.assignee.image}
          initials={info.assignee.name.slice(0, 1).toUpperCase()}
          alt={`Assigned to ${info.assignee.name}`}
          className="hidden bg-accent text-foreground outline-0 [--avatar-size:--spacing(5)] @xl:inline-grid"
        />
      )}
      <span className="w-14 text-end text-xs text-subtle-foreground tabular-nums">
        {rowTime(info.lastMessageAt)}
      </span>
    </span>
  );
}
