# @omni/web rules

Extends the root `AGENTS.md`. How the data layer works: `README.md`.

- `src/components/` and every visual decision belong to Rodrigo. Agents edit `src/lib/`,
  `src/hooks/`, `src/router.ts`, `src/main.tsx` and route guards/loaders unless asked for UI.
  When asked, follow `DESIGN.md` (repo root). Routes not yet designed stay bare placeholders.
- Components call hooks, never `lib/api.ts` directly. A new API call is a query or mutation in
  `lib/`, keyed in `lib/query-keys.ts`, exposed by a hook.
- Types come from `@omni/client` (the Worker's routes). Never redefine a response shape.
- Loading states use `skullet` (see `DESIGN.md`); route loaders should make most unnecessary.
- No unit tests here (`scripts/check-tests.mjs`). Prove behavior by running the app against the
  local stack, and push testable logic down into `@omni/client` or the Worker.
