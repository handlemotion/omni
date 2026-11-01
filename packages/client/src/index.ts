// The typed layer apps/web and apps/ios call: the Worker's routes over Hono RPC, Better Auth's
// client, and the realtime socket. Plain functions; no framework, no UI.
export * from "./api.ts";
export * from "./auth.ts";
export * from "./realtime.ts";
