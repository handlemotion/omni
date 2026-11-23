import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { members, users } from "../src/schema/index.ts";
import type { MemberStorage, StoragePlace, UserStorage } from "../src/storage.ts";
import type { createTestDatabase } from "./support.ts";

type TestDb = Awaited<ReturnType<typeof createTestDatabase>>["db"];
type Uploader = Pick<
  MemberStorage | UserStorage,
  "openUpload" | "recordUploadPart" | "completeUpload" | "createFolder"
>;

export async function addFile(
  storage: Uploader,
  place: StoragePlace,
  name: string,
  size = 10,
  mimeType: string | null = null,
) {
  const opened = await storage.openUpload(place, { name, size, mimeType, limitBytes: null });
  if (opened.status !== "ok") throw new Error(`open: ${opened.status}`);
  await storage.recordUploadPart(opened.upload.id, { partNumber: 1, etag: "etag-1", size });
  const done = await storage.completeUpload(opened.upload.id, { limitBytes: null });
  if (done.status !== "ok") throw new Error(`complete: ${done.status}`);
  return done.node;
}

export async function addFolder(storage: Uploader, place: StoragePlace, name: string) {
  const made = await storage.createFolder(place, name);
  if (made.status !== "ok") throw new Error(`folder: ${made.status}`);
  return made.node;
}

/** A teamspace the member makes and owns: the place to put a test's files in Drive. */
export async function addTeamspace(
  storage: Pick<MemberStorage, "createTeamspace">,
  name: string,
  options: { private?: boolean; memberIds?: string[] } = {},
) {
  const made = await storage.createTeamspace({ name, ...options });
  if (made.status !== "ok") throw new Error(`teamspace: ${made.status}`);
  return { teamspaceId: made.teamspace.id };
}

/** A person with a verified primary address, as a magic-link sign-in leaves them. */
export async function createPerson(db: TestDb, email: string) {
  const [user] = await db
    .insert(users)
    .values({ id: randomUUID(), name: email, email, emailVerified: true })
    .returning();
  return user!;
}

export async function setRole(db: TestDb, memberId: string, role: string) {
  await db.update(members).set({ role }).where(eq(members.id, memberId));
}
