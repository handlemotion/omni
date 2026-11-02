# @omni/web rules

Extends the root `AGENTS.md`. How the data layer works: `README.md`.

- `src/components/` and every visual decision belong to Rodrigo. Agents edit `src/lib/`,
  `src/hooks/`, `src/router.ts`, `src/main.tsx` and route guards/loaders. Route components are
  placeholders until Rodrigo replaces them; keep them bare (raw data, plain elements).
- Components call hooks, never `lib/api.ts` directly. A new API call is a query or mutation in
  `lib/`, keyed in `lib/query-keys.ts`, exposed by a hook.
- Types come from `@omni/client` (the Worker's routes). Never redefine a response shape.
- Loading states use `skullet`; route loaders should make most of them unnecessary.
- No unit tests here (`scripts/check-tests.mjs`). Prove behavior by running the app against the
  local stack, and push testable logic down into `@omni/client` or the Worker.
