# @omni/client rules

Extends the root `AGENTS.md`.

- The typed layer `apps/web` and `apps/ios` call: `createApi` (Hono RPC from the Worker's
  `AppType`), `createAuth` (Better Auth client with the same plugins as `@omni/auth`), and
  `connectRealtime`. Plain functions; no components, styling, or framework hooks.
- Types come from the Worker, never redefined here. A new route shows up in `createApi` by itself;
  export a named response type only when the apps need to name it.
- Runs in browsers and React Native: only `fetch`, `URL` and `WebSocket`. Anything
  platform-specific (cookie storage, socket headers) is passed in by the app.
- Proven only by `e2e/` against the real Worker; no unit tests.
