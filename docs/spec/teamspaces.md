# Teamspaces: Drive organized like Notion

Nov 22, 2026 · Draft · Extends `docs/spec/v1.md` (Drive) and `docs/spec/crm.md` ("Keep the files")

## Summary

Drive stops forcing two drives on everyone (My files and Shared). A workspace holds
**teamspaces**: named places anyone in the workspace can make, each with its own members. A
teamspace holds folders, docs and files, and the sidebar is the navigator: teamspaces, and the
folders inside them. A CRM deal gets its own private teamspace whose members are the project's
people.

"Workspace" stays the company (an organization, `org_id`). "Personal space" stays the Just me
workspace. The new thing is a teamspace in code and a **space** in the UI.

## The sidebar

Search, Recents and Trash, then **Spaces**: the spaces the member is in, each opening to its
folders (folders only; files are in the page), then New space, and Browse spaces when there are
open ones they are not in. My files and Shared show there only while they hold something. Recents
lists the files changed most recently in the member's spaces and drives, with what was shared
with them by address beside them, so Shared with me and the sidebar's Upload row go.

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
  folder through its grant, so the team-only Admin folder stays out of their reach. A deal made
  before teamspaces keeps its folder under `Shared / Clients`.

## Model

- `storage_teamspaces`: `id`, `org_id`, `name`, `private`, `created_by_member_id`, timestamps.
- `storage_teamspace_members`: (`teamspace_id`, `member_id`), `org_id`, `role` (`owner` |
  `member`). A member who leaves the workspace leaves its teamspaces.
- A node in a teamspace has `space = 'teamspace'` and `teamspace_id` set; a drive is
  `(org_id, space, owner_member_id, teamspace_id)`. Uploads in progress and tombstones carry
  `teamspace_id` too.

## Expand, then contract

My files and Shared keep working as they are, for every client, while teamspaces arrive:

1. **This stack.** Teamspaces, their members and their access, through the member door; the web
   sidebar lists them, and My files and Shared only while they hold something; a new CRM deal
   makes its teamspace. Search, Trash, the agent's Drive tools and moves between drives include
   teamspaces.
2. **Next.** Desktop sync and iOS list teamspaces (desktop: a folder per teamspace the person is
   in, beside My files and Shared, `docs/spec/desktop.md`). My files and Shared move into teamspaces once
   (a private teamspace per member who has files, an open "Shared" teamspace), in an idempotent
   job.
3. **Last.** Once no client reads them, the `personal` and `shared` drives go.

## Verify

- `packages/db/e2e/storage-teamspaces.e2e.test.ts`: who reaches an open and a private
  teamspace; a freelancer only when added; managing it; a move between teamspaces; deleting one.
- `apps/worker/e2e/storage-teamspaces.e2e.test.ts`: the routes, end to end.
- On the stack: make a private teamspace, add a doc, open it, add a member; a new deal has its
  teamspace with the project's people.
