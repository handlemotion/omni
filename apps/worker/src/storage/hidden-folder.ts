import type { MemberStorage } from "@omni/db";

const FOLDER_PAGES = 20;

async function isPrivate(files: MemberStorage, folderId: string) {
  const shared = await files.sharing(folderId);
  return (
    shared.status === "ok" &&
    shared.sharing.people.length === 0 &&
    shared.sharing.linkAccess === "restricted"
  );
}

/**
 * A private folder named `name` at the top of the member's hidden store (their My files), made on
 * first use: where recordings go, and the member's drafts. Null when Storage refuses.
 */
export async function hiddenFolder(files: MemberStorage, name: string) {
  let cursor = null;
  for (let page = 0; page < FOLDER_PAGES; page++) {
    const listed = await files.list({ space: "personal" }, { cursor, limit: 200 });
    if (listed.status !== "ok") return null;
    for (const node of listed.nodes) {
      if (node.kind === "folder" && node.name === name && (await isPrivate(files, node.id))) {
        return node.id;
      }
    }
    if (listed.nodes.some((node) => node.kind === "file") || !listed.nextCursor) break;
    cursor = listed.nextCursor;
  }
  const made = await files.createFolder({ space: "personal" }, name);
  return made.status === "ok" ? made.node.id : null;
}

/** The folder a member's drafts are kept in: docs, sheets and folders made outside any space. */
export const DRAFTS_FOLDER = "Drafts";
