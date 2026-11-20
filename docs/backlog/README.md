# Backlog

Gaps found by a sweep of the repo on 2026-11-19: buggy logic, half-built features, missing error
handling, missing tests, and drift between the spec and the code. Each file is a
self-contained brief an agent can pick up: severity, files, evidence, the fix, and how to prove it.

Out of scope here because other threads own them: iOS visual polish and iOS parity, Drive sync to a
Mac folder, MCP sign-in.

Fixed during the sweep (#493): archive, trash, spam and not-spam now refresh teammates live; Expo
push and the mail notifier time out instead of failing ingest; four variables added to
`docs/self-hosting.md`.

How to use it: pick a brief, follow its "Before you start", and delete the file in the PR that
closes the gap. "Who" says when a step needs Rodrigo (a design call for `apps/web`, or a production
or business decision).

| #   | Gap                                                                                                                                      | Severity    | Area                             | Who                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------- | ------------------------------------------------ |
| 001 | [Production migrations wait hours for self-hosted runners while code deploys at once](001-production-runner-lag.md)                      | high        | Ops (.github)                    | Needs Rodrigo: which runners production jobs use |
| 002 | [Nightly Full e2e has failed six nights running, so worker, mail and web e2e give no signal](002-nightly-full-e2e-red.md)                | high        | CI / packages/client             | Agent                                            |
| 005 | [Spam and Trash are dead ends in the web app](005-web-spam-trash-dead-ends.md)                                                           | high        | Web (apps/web) mail              | Needs Rodrigo: menu labels and placement         |
| 006 | [Inbox signatures can be read but not set or removed](006-web-signatures-ui.md)                                                          | high        | Web settings                     | Needs Rodrigo: settings row design               |
| 007 | [CRM records can't be deleted, and domains and notes can't be removed or edited](007-web-crm-delete-edit.md)                             | high        | Web CRM                          | Needs Rodrigo: menu items and confirm dialog     |
| 009 | [Sends and archives wait behind a whole folder import, and stall the outbox for every mailbox](009-outbox-waits-behind-import.md)        | medium-high | Mail outbox (apps/mail)          | Agent                                            |
| 010 | [CRM features have a backend but no UI](010-web-crm-ui.md)                                                                               | medium-high | Web mail + CRM                   | Needs Rodrigo: design                            |
| 012 | [Dialogs, settings and notifications show a skeleton forever, or a false empty state, when a fetch fails](012-web-stuck-skeletons.md)    | medium      | Web (error states)               | Agent (UI owned by Rodrigo; no new copy needed)  |
| 013 | [New-mail notifications and pushes are lost if anything fails after ingest](013-new-mail-push-once.md)                                   | medium      | Worker realtime                  | Agent                                            |
| 014 | [The per-kind push setting does nothing; mentions and assignments never push; dead tokens aren't pruned](014-push-preferences.md)        | medium      | Worker realtime                  | Agent (+ Rodrigo for the settings UI)            |
| 015 | [`storage.changed` realtime events are dropped by `@omni/client`, so Drive doesn't refresh live](015-storage-changed-dropped.md)         | medium      | packages/client, Worker realtime | Agent (+ Rodrigo for the web handler)            |
| 017 | [Turning off Purelymail symbolic subaddressing is never retried after a failure](017-purelymail-subaddressing-retry.md)                  | medium      | Mail hosting (apps/mail)         | Agent, but confirm with Rodrigo                  |
| 018 | [A mailbox connection that gives up stays dead until the next deploy](018-mailbox-gave-up-never-retried.md)                              | medium      | Mail supervisor (apps/mail)      | Agent                                            |
| 019 | [Spec v1 and AGENTS.md contradict the code; suggested replies and the token cap aren't built](019-spec-and-agents-drift.md)              | medium      | Docs                             | Agent (AGENTS.md edits need Rodrigo's OK)        |
| 020 | [Purelymail reselling is still an open question while hosted mailboxes are sold](020-purelymail-reselling.md)                            | medium      | Business                         | Rodrigo                                          |
| 021 | [Notification preferences, undo-send and presence are built but have no UI](021-web-preferences-presence.md)                             | medium      | Web settings + conversation      | Needs Rodrigo: design                            |
| 022 | [Desktop: Launch at login is forced on, and mailto links leave Omni](022-desktop-autostart-mailto.md)                                    | medium      | Desktop + web                    | Needs Rodrigo: settings row                      |
| 023 | [No check stops a PR from reading a column its own migration adds](023-expand-contract-check.md)                                         | low-medium  | Policy scripts                   | Agent (root config: propose first)               |
| 024 | [Google connect uses the session's active workspace, not the tab's](024-google-connect-workspace.md)                                     | low-medium  | Worker connect                   | Agent                                            |
| 025 | [Mail service loose ends: duplicate send after crash, leftover app password, Sentry noise, fetch timeouts](025-mail-small-loose-ends.md) | low         | apps/mail                        | Agent                                            |
| 026 | [Worker loose ends: `action.succeeded` never sent, AI usage double-counted, upload cleanup unbounded](026-worker-small-loose-ends.md)    | low         | apps/worker, packages/db         | Agent                                            |
| 027 | [Orphan routes and dead web code](027-dead-code-and-orphans.md)                                                                          | low         | Web + Worker                     | Agent (deletions in web: ask Rodrigo)            |
| 028 | [Partly enforced policies](028-partly-enforced-policies.md)                                                                              | low         | Docs + scripts                   | Agent                                            |
| 029 | [Closed, unmerged: start a comment thread from selected editor text (#443)](029-pr-443-comment-from-selection.md)                        | low         | Web Drive                        | Rodrigo: wanted or dropped?                      |
