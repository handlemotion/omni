import type { TalkEvent } from "@omni/contracts";
import { logOf, TEAM, teamOf } from "./realtime-log.ts";

/**
 * Set (by the Worker, never the client) on a teammate's app socket: they are someone Talk shows
 * as online, and they hear who comes and goes. Such a socket also carries the `team` tag.
 */
export const TEAM_HEADER = "x-omni-team";
export const TEAM_TAG = "team";

const isOpen = (socket: WebSocket) => socket.readyState === WebSocket.OPEN;

function hasTeamSocket(ctx: DurableObjectState, memberId: string, except?: WebSocket) {
  return ctx
    .getWebSockets(memberId)
    .some((s) => s !== except && isOpen(s) && ctx.getTags(s).includes(TEAM_TAG));
}

function tell(ctx: DurableObjectState, event: TalkEvent) {
  const message = logOf(ctx).append([TEAM], event);
  for (const socket of ctx.getWebSockets(TEAM_TAG)) {
    try {
      socket.send(message);
    } catch {}
  }
}

/** The teammates with Omni open in this workspace now. */
export function onlineMembers(ctx: DurableObjectState) {
  const online = new Set<string>();
  for (const socket of ctx.getWebSockets(TEAM_TAG)) {
    const memberId = ctx.getTags(socket)[0];
    if (memberId && isOpen(socket)) online.add(memberId);
  }
  return [...online];
}

/** A teammate socket was accepted: when it is their first, everyone hears they are online. */
export function teamSocketOpened(ctx: DurableObjectState, socket: WebSocket, memberId: string) {
  if (hasTeamSocket(ctx, memberId, socket)) return;
  tell(ctx, { type: "talk.online", memberId, online: true });
}

/** A socket closed: when it was a teammate's last, everyone hears they went offline. */
export function teamSocketClosed(ctx: DurableObjectState, socket: WebSocket) {
  const [memberId, ...rest] = ctx.getTags(socket);
  if (!memberId || !rest.includes(TEAM_TAG) || hasTeamSocket(ctx, memberId, socket)) return;
  tell(ctx, { type: "talk.online", memberId, online: false });
}

/**
 * Closes the sockets under `tags` of a member leaving the workspace or changing role, so what they
 * hear is decided afresh: a reconnect is refused once they are gone, and tagged for Talk only if
 * their new role has it. If Talk showed them, everyone sees them go.
 */
export function closeMember(ctx: DurableObjectState, memberId: string, tags: string[]) {
  const wasOnline = hasTeamSocket(ctx, memberId);
  for (const socket of tags.flatMap((tag) => ctx.getWebSockets(tag))) {
    try {
      socket.close(4403, "membership changed");
    } catch {}
  }
  if (wasOnline) tell(ctx, { type: "talk.online", memberId, online: false });
}

/** Sends a Talk event to these members' Talk apps; returns the members with none open. */
export function sendTalk(ctx: DurableObjectState, memberIds: string[], event: TalkEvent) {
  const members = [...new Set(memberIds)];
  const message = logOf(ctx).append(members.map(teamOf), event);
  const away: string[] = [];
  for (const memberId of members) {
    const sockets = ctx
      .getWebSockets(memberId)
      .filter((s) => isOpen(s) && ctx.getTags(s).includes(TEAM_TAG));
    if (sockets.length === 0) away.push(memberId);
    for (const socket of sockets) {
      try {
        socket.send(message);
      } catch {}
    }
  }
  return away;
}
