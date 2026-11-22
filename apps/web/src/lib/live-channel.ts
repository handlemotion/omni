import {
  connectRealtime,
  type Api,
  type RealtimeClientMessage,
  type RealtimeEvent,
} from "@omni/client";
import type { InferResponseType } from "hono/client";
import { api, call } from "./api.ts";
import { onDocEvent, onRealtimeOpen, sendRealtime } from "./realtime.ts";

type ChannelEvent = Extract<
  RealtimeEvent,
  {
    type:
      | "doc.record"
      | "doc.appended"
      | "doc.refused"
      | "doc.presence"
      | "doc.access"
      | "doc.comments";
  }
>;
type LivePage = InferResponseType<Api["storage"]["files"][":id"]["live"]["$get"], 200>;

export interface LiveChannel {
  send(message: RealtimeClientMessage): void;
  read(nodeId: string, from: number | "latest"): Promise<LivePage>;
  onEvent(listener: (event: ChannelEvent) => void): () => void;
  onOpen(listener: () => void): () => void;
  close(): void;
}

export const memberChannel: (orgId: string) => LiveChannel = (orgId) => {
  return {
    send: (message) => void sendRealtime(orgId, message),
    read: (nodeId, from) =>
      call(
        api.storage.files[":id"].live.$get({
          param: { id: nodeId },
          query: { from: String(from) },
        }),
      ),
    onEvent: (listener) => onDocEvent(listener),
    onOpen: (listener) => onRealtimeOpen((opened) => opened === orgId && listener()),
    close: () => {},
  };
};

export const sharedChannel: (shared: SharedLive, nodeId: string) => LiveChannel = (
  shared,
  nodeId,
) => {
  const events = new Set<(event: ChannelEvent) => void>();
  const opens = new Set<() => void>();
  let opened = false;
  const socket = connectRealtime({
    baseUrl: window.location.origin,
    shared: { shareId: shared.shareId, nodeId, onEnded: () => shared.onAccess(null) },
    onEvent: (event) => {
      if (!event.type.startsWith("doc.")) return;
      for (const listener of events) listener(event as ChannelEvent);
    },
    onStatus: (status) => {
      if (status !== "open") return;
      if (opened) shared.onReconnected();
      opened = true;
      for (const listener of opens) listener();
    },
  });
  return {
    send: (message) => void socket.send(message),
    read: (id, from) =>
      call(
        api.storage.shared[":shareId"].files[":id"].live.$get({
          param: { shareId: shared.shareId, id },
          query: { from: String(from) },
        }),
      ),
    onEvent: (listener) => {
      events.add(listener);
      return () => events.delete(listener);
    },
    onOpen: (listener) => {
      opens.add(listener);
      return () => opens.delete(listener);
    },
    close: () => socket.close(),
  };
};

/** A doc opened through its share link by someone outside the workspace. */
export interface SharedLive {
  shareId: string;
  /** Their role on it changed (`null`: the link no longer opens it to them). */
  onAccess: (role: "editor" | "commenter" | null) => void;
  /** Its socket opened again: its role may have changed while it was away. */
  onReconnected: () => void;
}
