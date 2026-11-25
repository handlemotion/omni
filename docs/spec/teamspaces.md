# Teamspaces: Drive organized like Notion

Nov 22, 2026 · Draft · Extends `docs/spec/v1.md` (Drive) and `docs/spec/crm.md` ("Keep the files")

## Summary

Drive no longer has My files or Shared. A workspace holds
**teamspaces**: named places anyone in the workspace can make, each with its own members. A
teamspace holds folders, docs and files, and the sidebar is the navigator: teamspaces, and the
folders inside them. A CRM deal gets its own private teamspace whose members are the project's
people.

"Workspace" stays the company (an organization, `org_id`). "Personal space" stays the Just me
workspace, which has teamspaces like any other. The new thing is a teamspace in code and a **space** in the UI.

## The sidebar

The sidebar is the navigator. At its top: **New** (a menu that makes a doc, a folder or a space
where the member is; a sheet once the web app can edit one), **Drafts** and **Recents**, and
Browse spaces when there are open ones they are not in; Search too on a phone. Then each space the
member is in, its name as a small section header (it opens the space's top; its chevron, shown on
hover, folds it), with everything in it below, folders and files, as a tree: a folder opens its
own. My files and Shared are retired and never show. Recents lists the files changed most
recently in the member's spaces and drives, with what was shared with them by address beside
them, so Shared with me and the sidebar's Upload row go. Trash is not in the sidebar: it is a
page in Settings.

**Drafts** is what a member makes outside any space: New outside a space makes it there. It is a
private `Drafts` folder in their hidden store (`GET /api/storage/drafts` finds or makes it, as
Meetings does its `Recordings`); a draft moves into a space like any file.

A folder's page has two actions in its header: a bordered **+** (New doc, New folder, Upload
files, Upload folder) and **Share** (a folder's people and link; at a space's top, the space's
members and settings). Folders show as cards only.

## Rules

- **Members only.** A teamspace's members are members of its workspace. People outside it keep
  reaching single files and folders the way they do now: by grant or by link.
- **Anyone makes one.** Any member of the workspace creates a teamspace and becomes its owner.
- **Open or private.** An open teamspace is reached by every member of the workspace, as Shared
  is today (a freelancer only when added). A private one is reached only by its members and the
  workspace's owners and admins; nobody else sees it exists.
- **Leaving.** When a teamspace's only owner leaves the workspace, whoever receives their My
  files becomes its owner, so no teamspace is left without one.
- **Nothing is forced.** A new member gets no drive of their own and a new workspace gets no
  teamspace. Whoever wants a place of their own makes a private teamspace with only themselves
  in it.
- **Managing it.** Its owners and the workspace's owners and admins rename it, make it open or
  private, pick its icon in the sidebar, add and remove members, change roles and delete it. A
  teamspace always keeps one owner. Deleting one needs it to hold nothing outside Trash; what is
  in its Trash goes for good. Folders take no icon of their own: the folder glyph everywhere.
- **Inside it,** a member does what they do in Shared now: everyone writes, and the uploader, the
  teamspace's owners and the workspace's owners and admins move something out of it (to Trash or
  to another teamspace). Grants, links, comments, versions, locks and signatures work as before.
- **CRM.** Creating a deal creates an open teamspace named after it: the team reaches every
  project, as before. Its creator owns it and the deal's owner is in it; the deal's folder sits at
  its top. Freelancers and clients on the project are not in it: they keep reaching the project's
  folder through its grant, so the team-only Admin folder stays out of their reach. A company's
  folder, and the folder of a deal made before teamspaces, is made the first time it is needed at
  the top of a new open teamspace named after the record, owned by whoever needed it.

## Model

- `storage_teamspaces`: `id`, `org_id`, `name`, `private`, `created_by_member_id`, timestamps.
- `storage_teamspace_members`: (`teamspace_id`, `member_id`), `org_id`, `role` (`owner` |
  `member`). A member who leaves the workspace leaves its teamspaces.
- A node in a teamspace has `space = 'teamspace'` and `teamspace_id` set; a drive is
  `(org_id, space, owner_member_id, teamspace_id)`. Uploads in progress and tombstones carry
  `teamspace_id` too.

## My files and Shared are retired

The `personal` and `shared` drives are gone from the product (Nov 23, 2026; no data in them was
kept):

- Nothing in Wok puts a file in Shared, and nothing but Talk and Meetings puts one in My files.
- No sidebar, listing, search, Recents, Trash, Shared with me, sync drive list or agent tool shows
  either. `/files/my` and `/files/shared` open Drive; a link to a folder inside them still opens.
- A member's My files stays, unseen, as their **hidden store**: Talk drops
  (`docs/spec/talk.md`) and meeting recordings and notes docs (`docs/spec/meetings.md`) are kept
  there, counted against storage like any file, and opened only from Talk or the meeting. A grant
  on a file there opens it for the grantee and lists it nowhere.
- The HTTP API still takes `space=personal|shared` for clients built before this (iOS, desktop
  sync). The last step, once none sends it: the old rows go, and `personal` is renamed for what it
  now is.

## Verify

- `packages/db/e2e/storage-teamspaces.e2e.test.ts`: who reaches an open and a private
  teamspace; a freelancer only when added; managing it; a move between teamspaces; deleting one.
- `apps/worker/e2e/storage-teamspaces.e2e.test.ts`: the routes, end to end.
- On the stack: make a private teamspace, add a doc, open it, add a member; a new deal has its
  teamspace with the project's people.
