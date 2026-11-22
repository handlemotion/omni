# Omni contracts: Drive's own contracts

Nov 22, 2026 · Draft for review · Extends `docs/spec/docs.md` and `docs/spec/crm.md` ("Store the
contract", "Sign the contract in Omni"); builds on versions by editing session (#706), agent
versions and `drive_versions` (#707), and Storage's signing

## Summary

A contract becomes an Omni file type of its own, as docs are and sheets and canvases will be. It
lives in Drive, is written in the doc editor, and adds what a contract needs and a doc does not:
named drafts you can compare, a record of who wrote each passage (a person or an agent), and
sending for signature from the file itself.

The CRM stops owning the document. A deal's contract record references a contract that lives in
Drive, wherever it is: an Omni contract, or any PDF or Word file the team already has. Picking
one never forces an upload or a copy.

Two words, used the same way throughout:

- **Omni contract:** the Drive file, type `text/vnd.omni.contract`.
- **Contract record:** the CRM's row (`crm_contracts`) on a deal or a company. It references one
  Drive file as its document and keeps the CRM's own facts: the record it is on, the people it
  involves, its dates and its place on the timeline.

## What it is, and what it is not

| An Omni contract is                                          | It is not                                                  |
| ------------------------------------------------------------ | ---------------------------------------------------------- |
| A Drive file, shared, found and moved like any other         | A CRM object: it lives in Drive and works without the CRM  |
| A doc's body and editor, live for the whole team             | A layout tool: no page setup, fonts or fields placed on a page |
| Named drafts on one line of history, compared two at a time   | Branches: two drafts are never edited in parallel           |
| Attributed passage by passage, to members and their agents   | A tracked-changes Word file                                |
| Frozen, rendered to PDF and signed with Storage's signing    | A second signing system                                    |

## The type

- An Omni contract is a Drive file whose type is `text/vnd.omni.contract` (`CONTRACT_TYPE` and
  `isOmniContract` in `@omni/docs`, beside `DOC_TYPE`). Names carry no extension.
- Its body is Markdown, as a doc's is, on the same Tiptap schema. Search, `drive_fetch`, the live
  document, versions, comments and text extraction read it with no new code path, and the type
  starts with `text/`, so extraction reads it as text. `isDocFile` answers true for it: every
  place that opens a doc opens a contract. `isOmniDoc` stays false: the places that make a
  contract differ from a doc ask `isOmniContract`.
- Drive shows it with a contract glyph and the badge `CONTRACT`. **New → Contract** makes
  `Untitled contract`. **Convert to Omni contract**, from an Omni doc's or a Markdown file's ⋯
  menu, saves its text as the next version with the contract type, as Convert to Omni doc does.
  PDFs and Word files are not converted: they are referenced as they are (below).
- Export is a doc's (Word, PDF, Markdown). A PDF from Export is a reading copy; only Send for
  signature makes the PDF that is signed.
- Package names: `@omni/contracts` is already the API's shared shapes. Contract code goes in
  `@omni/docs` (type, Markdown to PDF layout, comparing), `@omni/db`'s Storage module and the
  Worker's `storage/`, never in a package called contracts.

## Drafts

A contract's history is its versions, as for every file: one per editing session, one per agent
edit (#706). A **draft** is a version someone named.

- **Save as draft**, in the contract's bar, names the content as it is now ("Sent to Acme
  legal", "Our redline, round 2"). Naming ends the editing session: the next keystroke starts a
  new version, so a named draft is never superseded by later autosaves of the same session.
- A named version is kept as long as the file is: the purge of versions replaced more than
  `STORAGE_VERSION_DAYS` (30) ago and the day-old purge of superseded autosaves both pass over
  it. Renaming and unnaming are free; unnaming lets it age like any other version.
- Drafts are one line. Restoring a draft makes it the current content as the next version, as
  restoring any version does, and the drafts after it stay in history. Two parallel drafts (ours
  and the client's) are two contracts: **Make a copy** (new with the type, step 3) makes the
  second.
- **Compare** takes any two versions, drafts or not, and the current content: blocks added,
  removed and changed, and inside a changed block the words. Each change is colored by who made
  it (Attribution, below). It reads the two bodies from the bucket and diffs them in the browser
  with `@omni/docs`'s `compareMarkdown`, the same diff `drive_versions` gives agents.
- Model: `storage_version_names` (`org_id`, `node_id`, `content_version`, `name`,
  `named_by_member_id`, `named_at`), one row per named version, unique on
  `(node_id, content_version)`. Naming the current content names the version the file holds now:
  the row is keyed by content version, so it still finds it once the next save turns it into a
  `storage_versions` row. It is a Storage table: any file's versions can carry names, and the
  contract editor is the first to show them.

## Attribution

Every passage of a contract says who wrote it: a member, a member's agent ("Claude, for Ana"),
or someone outside the workspace editing through a link.

- **Who wrote a change.** The Worker stamps each live record it appends with its author,
  `by: { m: memberId, a: agent | null }` (or the link's grantee for an outside editor), from the
  socket or the agent's grant, never from the client. The field is optional in
  `storageLiveRecordSchema`, so readers that do not know it skip it.
- **Who wrote a passage.** Yjs gives every inserted run of text the client id that wrote it. The
  first stamped record that writes under a client id binds that id to its author; a later record
  from someone else writing under the same id is refused (`doc.refused`, reason `author`). So
  every run of text has one author, and nobody can write in another's name.
- **Kept in the bucket.** Each saved version of a contract gets an authors file beside its body
  (`<r2Key>.authors`, JSON): the authors, and the spans of the Markdown each one wrote. Whoever
  saves the version (a tab, or the Worker for an agent edit or a sweep of unsaved typing) writes
  it from the live document. Postgres holds none of it, so a rebuild from the bucket keeps
  attribution. A version saved outside the live layer (an upload, an older version) has no
  authors file and is attributed whole to the version's writer.
- **Shown.** Authors, in the contract's bar, colors the text by who wrote it, one color per
  person, with agents' passages marked as an agent's on their person's color; a passage's tooltip
  names its author and the version it arrived in. Compare uses the same colors.
- Docs can turn it on later: the stamp is written for every live document, and the authors file
  only for contracts in v1.

## Send for signature

Sending freezes one version, renders it to a PDF, and runs Storage's signing on that PDF
(`docs/spec/crm.md`, "Sign the contract in Omni"). Signers read and sign the PDF, never the live
document.

1. **Freeze.** Send for signature, in the contract's bar or from a deal, takes the current
   content and names it a draft ("Sent for signature, Nov 22") if it has no name. The contract is
   locked: the live layer refuses appends to a locked file (`locked`), so nobody edits it while it
   is out.
2. **Render.** The Worker renders that version's Markdown to a PDF with `pdf-lib`, already its
   dependency for the sealed copy: `@omni/docs` lays the blocks out (headings, paragraphs,
   lists, tables, dropdowns open) and the Worker draws them with a bundled open font. The same
   version always renders the same bytes: the PDF's dates are the freeze time. Text the font
   cannot draw refuses the send (`CONTRACT_UNRENDERABLE`, with the characters) instead of
   printing `?`. No browser and no new service run, so self-hosting needs nothing new.
3. **Sign.** The PDF lands beside the contract as `<name> (version N).pdf` and goes out through
   `sendForSignature` with its hash and content version, as any PDF does today. The rest is
   today's flow: a code to each signer, their link, the audit trail, the sealed copy with its
   certificate beside the PDF.
4. **Outcome.** When every signer has signed, the contract stays locked for good and shows its
   sealed copy. Voiding unlocks it; the PDF stays beside it as the record of what was sent. A
   signed contract changes only through a new one: Make a copy starts the amendment.

- Model: `storage_contract_sends` (`signature_request_id` primary key, `org_id`, `node_id`, the
  contract, `content_version`, the frozen version, `pdf_node_id`), written in the transaction
  that opens the request. A contract's signing state is its latest send's request: draft (none,
  or the latest voided), out, signed.
- Only members send, as today, and an agent never does: `drive_*` and `crm_write` cannot send or
  void.

## In the CRM

A contract record references a contract in Drive. Today's picker offers the files of the
record's own folder or an upload; it becomes three ways in:

- **From Drive.** Any file in the workspace's drives the member can open: an Omni contract, a
  PDF, a Word file, anything. It is referenced where it lives, as "Add from Drive" links files: it
  is not moved into the deal's `Admin` folder or copied. Only a file loose in the deal's own folder
  is filed into `Admin`, as today. A file in someone's My files is refused (`documentNodeId`): it
  is not the team's. A signed copy picked this way is any PDF in the workspace's drives.
- **New Omni contract.** Makes an Omni contract in the deal's `Admin` folder (the company's
  folder for a company's record), named after the record's title, and opens it.
- **Upload PDF.** Stays: the file lands in the record's folder, as now.

What follows from referencing in place:

- **Locking where it lives.** A contract marked signed locks its file in its own folder; the lock
  is the same lock, so the file cannot be renamed, moved or deleted there either.
- **Freelancers.** A freelancer the contract involves gets viewer on its document and signed copy
  wherever they are, and loses it when taken off, as today.
- **One contract, several deals.** One MSA can be the document of records on several deals.
- **Signing an Omni contract.** A record whose document is an Omni contract sends it through the
  contract's own send (`POST /contracts/:id/send` calls it), and its `signatureRequestId` is that
  send's request. Its status follows the file: `sent` while the contract is out, `signed` with the
  sealed copy as `signedNodeId` when it completes, `draft` when voided. Every record referencing
  that contract follows the same send, so signing the MSA from one deal shows it signed on every
  deal it is on. `ended` and the dates stay the record's, so expiry keeps running in the CRM's
  daily job. Mark sent and Mark signed by hand stay for PDFs and Word files only.

## API

Storage, under `/api/storage`, shapes in `@omni/contracts/storage.ts`:

| Route                                              | Does                                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET /files/:id/drafts`                            | The file's named versions, newest first.                                               |
| `PUT /files/:id/drafts/:contentVersion` · `DELETE` | Names (or renames) a version, the current one included; unnames it. Editors only.      |
| `GET /files/:id/authors?version=`                  | A version's authors and spans; the current content when left out.                      |
| `POST /files/:id/contract/send`                    | `{ signers }`: freeze, render, send. `NOT_A_CONTRACT`, `SIGNATURE_OPEN`, `CONTRACT_UNRENDERABLE`. |
| `POST /files/:id/contract/void`                    | Voids its open send; the contract unlocks.                                             |
| `GET /files/:id/contract`                          | Its sends, newest first, each with the frozen version, PDF, signers and sealed copy.   |

Comparing needs no route: both bodies come from `GET /files/:id/versions/:id/content`, and the
diff runs in the browser. The CRM's routes keep their shapes; `CrmContract` gains `document`
(`{ id, name, mimeType }`, null when none or not visible) so the apps show a file that sits outside
the record's folder by name.

## Agents

- `drive_create_doc` takes `kind: "contract"` and makes an Omni contract. `drive_edit_doc` edits
  one as a doc, and the edit is attributed to the agent, for its member.
- `drive_versions` lists named drafts with their names and compares any two.
- `crm_write`'s `contract` takes any workspace file as its document. Agents name drafts; they
  never send, void or mark signed.

## Expand, then contract

Every contract record already references a Drive file, so nothing existing has to move. Each
step is its own deploy, in this order; step 3 waits until step 2 is live in production:

1. **Reference any workspace file** (no migration). A contract's document and signed copy may be
   any file the member opens outside My files, in place; the check becomes "not in My files" (not
   "in Shared"), so teamspace files (`docs/spec/teamspaces.md`) work the day they ship. The web's
   picker gains From Drive. Old clients keep sending `documentNodeId` as before.
2. **Readers first** (no migration): `CONTRACT_TYPE` and `isOmniContract` in `@omni/docs`,
   `isDocFile` answering true for it, and every gate that asks it (the web's `file-kind.ts`, the
   Worker's doc routes and tools in `storage/docs.ts`) opening a contract as a doc. Nothing makes
   a contract yet. Today a client or Worker that does not know the type shows it as plain text
   and refuses agent edits (`not_a_doc`): being Markdown inside does not get past those gates.
3. **Then the type is made** (no migration), once production's Worker and web app hold step 2:
   New → Contract, Convert, Make a copy, the editor in contract mode. Desktop and iOS, which
   update on their own schedule, read it as a plain file until they ship step 2's check.
4. **Drafts and Compare:** `storage_version_names`, numbered after the teamspaces stack's 0067
   and 0068. The purge skips named versions from the same deploy as the table.
5. **Attribution:** the optional `by` stamp, then the authors file. Readers that do not know the
   stamp ignore it; versions without an authors file read as their writer's.
6. **Send:** `storage_contract_sends`, the PDF render and the contract's send routes; then the
   CRM's send delegates for Omni contracts and its minute job settles every record referencing a
   completed send.
7. **The CRM's ways in:** New Omni contract, and `document` on `CrmContract`.

Contract, once no client needs it: the web's folder-only select goes (From Drive covers it), and
the Shared-only wording leaves `crm.md`. No column is dropped: PDF and Word contracts keep using
every field they use now.

## Not in this change

- Parallel drafts merged together, and importing a counterparty's tracked changes from Word.
- Fields placed on the page (signature boxes, initials) and per-signer order. Signers sign the
  whole PDF, as now.
- Templates with variables filled from the deal (`{{company.name}}`). New Omni contract starts
  empty; Make a copy of a past one is the template.
- Attribution for docs (the stamp is there; the authors file and the view are not).
- iOS and desktop: they open an Omni contract as a doc and do not send it.

## Verify

- Layer 1: `packages/db/e2e/crm-contracts.e2e.test.ts`: a deal's contract references a Shared
  file outside the deal's folder, which stays where it is when made, changed and signed, and is
  locked there; a My files file is refused. On the stack: pick a contract from Drive on a deal.
- Drafts: a named version survives its session's autosaves and the 30-day purge; Compare shows the
  changes between two drafts.
- Attribution: a member's and an agent's edits in one session come back as two authors' spans; a
  record reusing another author's client id is refused.
- Send: a frozen version renders the same PDF twice; while out, the live layer refuses edits; on
  completion every record referencing the contract is `signed` with the sealed copy; voiding
  unlocks it.
