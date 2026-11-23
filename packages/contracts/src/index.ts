export * from "./storage.ts";
export * from "./storage-live.ts";
export * from "./storage-history.ts";
export * from "./storage-teamspaces.ts";
export * from "./crm.ts";
export * from "./crm-access.ts";
export * from "./crm-links.ts";
export * from "./crm-meetings.ts";
export * from "./crm-plan.ts";
export * from "./crm-portal.ts";
export * from "./crm-tasks.ts";
export * from "./plans.ts";
export * from "./calendar.ts";
export * from "./invitations.ts";
export * from "./mail.ts";
export * from "./errors.ts";
export * from "./error-schemas.ts";
export * from "./mail-service.ts";
export * from "./helpdesk-realtime.ts";
export * from "./talk.ts";
export * from "./meetings.ts";
export * from "./desktop-recorder.ts";

/** What a module tells a workspace's open apps when its records change. */
export type ModuleChangedEvent =
  | import("./crm.ts").CrmChangedEvent
  | import("./storage.ts").StorageChangedEvent
  | import("./calendar.ts").CalendarChangedEvent
  | import("./meetings.ts").MeetingsChangedEvent;
