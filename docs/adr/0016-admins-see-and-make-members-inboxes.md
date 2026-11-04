# 0016: Owners and admins see every mailbox, and make a teammate's inbox, without reading it

Date: 2026-11-04 · Status: accepted

## Context

Settings listed only the mailboxes the signed-in member can open (`GET /api/mailboxes`). An owner
or admin could not see which teammates have a personal inbox in the workspace, whether it syncs,
or every shared mailbox. Mailboxes were created only during setup, and ADR 0007 gave the creator
the owner grant on each one: "granting an invited teammate their own mailbox when they join is
not done yet".

## Decision

1. **`GET /api/workspace/mailboxes`** (owners and admins; anyone else gets 403) lists every
   mailbox of the active workspace: id, address, kind, provider, status, last folder sync, how
   many members have a grant, and for a personal mailbox its owner (member id, name, email,
   picture). It carries no mail and grants nothing: an admin sees that Ben's inbox exists and
   whether it is healthy, never what is in it. The query is `listWorkspaceMailboxes` in
   `@omni/db`; it reads `mailboxes`, `mailbox_access` and `mailbox_folders.synced_at` only.
2. **`POST /api/onboarding/mailboxes` takes an optional `forMemberId`**, a member of the active
   workspace. The mailbox is then that member's personal inbox at any address on a verified
   domain: they get the owner grant, the creator gets none. Without it, ADR 0007's rule stands.
   Settings uses the same route after setup, for "Add a shared mailbox" and "Create an inbox".
3. **Provisioning an existing address never changes whose it is.** The route answers 409 when
   the address is already a mailbox of the other kind, or a personal inbox of someone else. The
   mail service's `saveMailbox` keeps existing grants when it replaces a login, so without this
   an admin could turn a teammate's personal inbox into a shared mailbox they are on.

## Consequences

- The privacy line is drawn in the API, not the UI: nothing in this change reads threads or adds
  a grant on someone else's personal mailbox. `forMember` is unchanged.
- On a domain on the member's own mail host (`imap`), the admin types that inbox's existing
  password to create it, as during setup (ADR 0007's pass-through). On Purelymail no one does.
- Proven in `apps/worker/e2e/workspace-mailboxes.e2e.test.ts` on the real Worker, mail service,
  GreenMail and Postgres. The Purelymail path still cannot run locally (ADR 0007).
