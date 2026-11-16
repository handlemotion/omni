import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { threadQuery } from "../lib/mail-queries.ts";
import { outstandingSends } from "../lib/pending.ts";
import {
  onThreadsMerged,
  realtimeStatus,
  startRealtime,
  trackSends,
  type RealtimeConnections,
} from "../lib/realtime.ts";

/**
 * Keeps the realtime socket for `orgId`, the active workspace, open while mounted. The lists show
 * only the active workspace's mail (ADR 0014, amended: workspace isolation), so that is the one
 * socket that always stays open. Another workspace's opens only while (a) a thread of it is on
 * screen (a link opens it as that workspace's member) or (b) a send from one of its addresses
 * has not had its result yet, and closes once neither holds: its new messages and its sends'
 * results arrive there. A new `memberId` or org reopens the active one.
 */
export function useRealtimeConnection(orgId: string, options: { memberId?: string } = {}) {
  const client = useQueryClient();
  const { threadId } = useParams({ strict: false }) as { threadId?: string };
  // The reader's own query (same key), so this adds no request.
  const threadOrg = useQuery({
    ...threadQuery(threadId ?? ""),
    enabled: !!threadId,
    select: (thread) => thread.orgId,
  }).data;
  const sending = useSyncExternalStore(
    outstandingSends.subscribe,
    outstandingSends.get,
    outstandingSends.get,
  );
  // A string, so a re-render with the same orgs leaves the sockets alone.
  const others = [...new Set([threadId ? threadOrg : undefined, ...sending.map((s) => s.orgId)])]
    .filter((id): id is string => !!id && id !== orgId)
    .sort()
    .join(",");

  const connections = useRef<RealtimeConnections | null>(null);
  const followed = useRef(others);
  useEffect(() => trackSends(client), [client]);
  useEffect(() => {
    const opened = startRealtime(client, orgId);
    connections.current = opened;
    opened.follow(followed.current ? followed.current.split(",") : []);
    return () => {
      opened.stop();
      connections.current = null;
    };
  }, [client, orgId, options.memberId]);
  useEffect(() => {
    followed.current = others;
    connections.current?.follow(others ? others.split(",") : []);
  }, [others]);
}

/** `connecting`, `open` or `closed`: for a "reconnecting…" indicator. */
export function useRealtimeStatus() {
  return useSyncExternalStore(realtimeStatus.subscribe, realtimeStatus.get, realtimeStatus.get);
}

/**
 * Calls `follow(intoThreadId)` when the thread `threadId` is merged into another (its messages
 * and helpdesk state moved there), so a reader showing it can move to the survivor.
 */
export function useFollowMerge(threadId: string, follow: (intoThreadId: string) => void) {
  const latest = useRef(follow);
  latest.current = follow;
  useEffect(
    () =>
      onThreadsMerged((event) => {
        if (event.fromThreadIds.includes(threadId)) latest.current(event.intoThreadId);
      }),
    [threadId],
  );
}
