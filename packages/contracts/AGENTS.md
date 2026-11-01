# @omni/contracts rules

Extends the root `AGENTS.md`.

- The one place for what crosses the Worker ⇄ mail service boundary: HTTP paths, request bodies,
  and the `mail_actions.payload` shapes. Both sides import these schemas; neither redefines them.
- Zod only, no I/O, runs on Node and workerd.
- Changes are additive while both sides deploy separately: new optional fields or new event
  types. A receiver ignores event types it does not know.
