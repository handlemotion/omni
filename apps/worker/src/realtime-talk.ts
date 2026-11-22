import type { TalkEvent } from "@omni/contracts";

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
  const message = JSON.stringify(event);
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

/** Sends a Talk event to these members' Talk apps; returns the members with none open. */
export function sendTalk(ctx: DurableObjectState, memberIds: string[], event: TalkEvent) {
  const message = JSON.stringify(event);
  const away: string[] = [];
  for (const memberId of new Set(memberIds)) {
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
