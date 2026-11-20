# @omni/contracts rules

Extends the root `AGENTS.md`.

- The one place for what crosses the Worker ⇄ mail service boundary: HTTP paths, request bodies,
  and the `mail_actions.payload` shapes. Both sides import these schemas; neither redefines them.
- Zod only, no I/O, runs on Node and workerd.
- Changes are additive while both sides deploy separately: new optional fields or new event
  types. A receiver ignores event types it does not know.
- `src/storage.ts` is the exception to the first rule: Storage's client API, what the
  Worker answers the web and iOS apps under `/api/storage`. Same rules: zod only, additive.
  `src/crm.ts` is the same exception for the CRM's client API under `/api/crm`.
- `src/errors.ts` and `src/error-schemas.ts` are the other exception: the Worker's error answers
  to every client. `errors.ts` stays free of zod (clients load it via
  `@omni/contracts/errors`); a new code is one row in `ERROR_CODES`.
