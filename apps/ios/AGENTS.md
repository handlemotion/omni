# @omni/ios rules

Extends the root `AGENTS.md` and `DESIGN.md`. How to run it: `README.md`.

- Expo (SDK 58) with Expo Router. Screens live in `src/app/` and stay thin: they compose
  `src/components/` and call `src/lib/`. Visual decisions belong to Rodrigo, as on the web.
- Data comes only through `@omni/client` (`src/lib/api.ts`): the same typed routes and auth
  client as the web app. Never redefine a response shape; never call `fetch` on `/api` directly.
- TanStack Query for every read, keyed in one place. Every call names the app's workspace
  (`omni-workspace`, `src/lib/workspace.ts`), as a web tab names the one in its URL; switching
  workspace drops every cached answer but the workspace list.
- **Navigation.** The modules (Mail, Drive, CRM) are a native tab bar (`expo-router/native-tabs`),
  each tab a native stack. A module page's header (`ModuleToolbar`) holds two native menus: its
  pages on the left (the web sidebar's rows), the workspace switcher and Log out on the right.
  Native chrome draws SF Symbols; everything the app draws itself uses Central Icons.
- **Tokens** live in `src/theme/tokens.ts` and mirror `apps/web/src/styles.css` under the same
  role names. Change the web value first. Screens use token names only: no hex values, no raw
  font sizes.
- **Components only.** Primitives are in `src/components/ui/` (`Text`, `Button`, `TextField`,
  `Screen`, `Skeleton`, ...). Feature code never styles a raw `Text` or `Pressable`; when a
  primitive can't express a design, add a variant to it.
- **Icons** are Central Icons' React Native build (same set as the web: round, radius 3, stroke
  1.5), re-exported from `src/components/icons.ts` under our own names. Its licence forbids
  publishing the glyphs, so this app stays closed source like the web app.
- **Loading**: `Skeleton` from `components/ui` (the web's `skullet` has no React Native build).
  An action in progress is `<Button isPending>`.
- **No inline context text** (root rule): titles, labels and controls only.
- Sign-in is a magic link that ends on the app's scheme; `src/lib/session.ts` keeps the cookie
  the Worker hands back (`apps/worker/e2e/ios-sign-in.e2e.test.ts` proves the server side).
- No unit tests here (`scripts/check-tests.mjs`). Prove a change by bundling it
  (`pnpm --filter @omni/ios build:check`) and running it against the local stack (`README.md`).
