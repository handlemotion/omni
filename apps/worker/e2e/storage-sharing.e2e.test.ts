// Sharing (ADR 0034 decisions 3, 4 and 6) over the real Worker, Postgres and local R2, with real
// sign-ins: people added by address, the one link, the link door, the share mail and session
// scope. Limits and the read-only gate are in `storage-sharing-limits.e2e.test.ts`.
import { randomBytes, randomUUID } from "node:crypto";
import type { StorageNode } from "@omni/contracts";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { startStorageStack, type Person, type StorageStack } from "./storage-support.ts";
import { CookieJar, createOrg, sentMail, signIn, WEB_ORIGIN } from "./support.ts";

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({
    vars: { WEB_APP_URL: WEB_ORIGIN, RATE_LIMIT_STORAGE_LINK: "off" },
  });
});
afterAll(() => stack?.stop());

const anonymous = new CookieJar();
const names = (body: { nodes: StorageNode[] }) => body.nodes.map((node) => node.name);
const address = (name: string) => `${name}-${randomUUID().slice(0, 8)}@outside.test`;

/** Signs in with an address by magic link: someone new to Omni gets their account this way. */
async function signedIn(email: string) {
  const jar = new CookieJar();
  await signIn(stack.worker, stack.db, email, jar);
  return jar;
}

async function folder(person: Person, place: object, name: string): Promise<StorageNode> {
  const made = await stack.api(person.jar, "POST", "/folders", { name, ...place });
  if (made.status !== 201) throw new Error(`folder ${name}: ${made.status}`);
  return made.body.node;
}

/** Adds `email` to `nodeId` as `person`, and answers the item's link id. */
async function share(person: Person, nodeId: string, email: string, role = "viewer") {
  const put = await stack.api(
    person.jar,
    "PUT",
    `/nodes/${nodeId}/sharing/people/${encodeURIComponent(email)}`,
    { role },
  );
  if (put.status !== 200) throw new Error(`share: ${put.status}`);
  return put.body.sharing.shareId as string;
}

const shareMail = async (to: string) =>
  (await sentMail(stack.worker, to)).filter((mail) => mail.subject.includes("shared"));

async function ana() {
  const org = await stack.company(`acme-${randomUUID().slice(0, 8)}`);
  return { org, ana: await stack.member(org.id, "owner") };
}

// Catches: a grant that opens only the folder it is on and not what is inside, one that opens
// for any signed-in person, a removed person who keeps reading, a share mail that is never
// sent, sent twice or sent again on a role change, and a newcomer whose sign-up from that mail
// finds nothing.
test("a grant on a folder opens a file two levels down for that address only, by one mail, until it is removed", async () => {
  const { ana: owner } = await ana();
  const top = await folder(owner, { space: "personal" }, "Top");
  const mid = await folder(owner, { parentId: top.id }, "Mid");
  const bytes = randomBytes(3000);
  const deep = await stack.upload(owner.jar, { parentId: mid.id }, "deep.bin", bytes);
  const guestEmail = address("guest");

  // Typed with capitals and spaces: stored, mailed and matched as the plain address.
  const shareId = await share(owner, top.id, `  ${guestEmail.toUpperCase()} `);
  expect(shareId).toMatch(/^[A-Za-z0-9_-]{22}$/);
  const [mail, ...more] = await shareMail(guestEmail);
  expect(more).toEqual([]);
  expect(mail!.subject).toBe(`${owner.email} shared "Top" with you on Omni`);
  expect(mail!.text).toContain(`${WEB_ORIGIN}/s/${shareId}\n`);
  // A role change is not news: no second mail.
  expect(await share(owner, top.id, guestEmail, "editor")).toBe(shareId);
  expect(await share(owner, top.id, guestEmail, "viewer")).toBe(shareId);
  expect(await shareMail(guestEmail)).toHaveLength(1);
  const sharing = await stack.api(owner.jar, "GET", `/nodes/${deep.id}/sharing`);
  expect(sharing.body.sharing).toMatchObject({
    shareId: null,
    linkAccess: "restricted",
    people: [],
    inherited: [{ email: guestEmail, role: "viewer", nodeId: top.id, nodeName: "Top" }],
  });

  // The guest is new to Omni: the magic link makes their account, and the item is there.
  const guest = await signedIn(guestEmail);
  const mine = await stack.api(guest, "GET", "/shared-with-me");
  expect(mine.body.items).toMatchObject([
    { node: { id: top.id, name: "Top" }, role: "viewer", shareId },
  ]);
  const opened = await stack.api(guest, "GET", `/shared/${shareId}`);
  expect(opened.body).toMatchObject({ item: { node: { id: top.id }, role: "viewer" } });
  expect(names(opened.body)).toEqual(["Mid"]);
  const inside = await stack.api(guest, "GET", `/shared/${shareId}?node=${mid.id}`);
  expect(names(inside.body)).toEqual(["deep.bin"]);
  expect(inside.body.item.path.map((entry: { name: string }) => entry.name)).toEqual([
    "Top",
    "Mid",
  ]);
  const got = await stack.get(guest, `/shared/${shareId}/files/${deep.id}/content`);
  expect(got.status).toBe(200);
  expect(Buffer.from(await got.arrayBuffer())).toEqual(bytes);

  // Nobody else: not another signed-in person, not a visitor, and not by the member routes.
  const stranger = await signedIn(address("stranger"));
  for (const jar of [stranger, anonymous]) {
    expect((await stack.api(jar, "GET", `/shared/${shareId}`)).status).toBe(404);
    const refused = await stack.get(jar, `/shared/${shareId}/files/${deep.id}/content`);
    expect(refused.status).toBe(404);
    await refused.body?.cancel();
  }
  expect((await stack.api(stranger, "GET", "/shared-with-me")).body.items).toEqual([]);
  expect((await stack.download(guest, deep.id)).status).toBe(404);
  expect((await stack.api(guest, "GET", `/nodes?parent=${top.id}`)).status).toBe(404);

  // Removed, the very next request finds nothing.
  const removed = await stack.api(
    owner.jar,
    "DELETE",
    `/nodes/${top.id}/sharing/people/${encodeURIComponent(guestEmail)}`,
  );
  expect(removed).toMatchObject({ status: 200, body: { sharing: { people: [] } } });
  expect((await stack.api(guest, "GET", `/shared/${shareId}`)).status).toBe(404);
  const closed = await stack.get(guest, `/shared/${shareId}/files/${deep.id}/content`);
  expect(closed.status).toBe(404);
  expect((await stack.api(guest, "GET", "/shared-with-me")).body.items).toEqual([]);
});

// Catches: a Restricted link that answers a visitor (or says it exists), a link that serves
// other bytes or renders in the browser, a visitor who can write, see who else has access or
// walk out of the shared folder, and an old link that still opens after a reset.
test("a Restricted link is 404 to a visitor; Anyone lists and downloads and nothing more; reset, the old link is 404", async () => {
  const { ana: owner } = await ana();
  const kit = await folder(owner, { space: "personal" }, "Press kit");
  const bytes = randomBytes(5000);
  const logo = await stack.upload(
    owner.jar,
    { parentId: kit.id },
    "logo.svg",
    bytes,
    "image/svg+xml",
  );
  const payroll = await stack.upload(owner.jar, { space: "personal" }, "payroll.csv", bytes);
  const pressEmail = address("press");
  const shareId = await share(owner, kit.id, pressEmail);
  const content = (id: string, nodeId = logo.id, headers?: Record<string, string>) =>
    stack.get(anonymous, `/shared/${id}/files/${nodeId}/content`, headers);

  expect((await stack.api(anonymous, "GET", `/shared/${shareId}`)).status).toBe(404);
  expect((await content(shareId)).status).toBe(404);
  // A write on a link that is not open says no more than a read does.
  expect(
    (
      await stack.api(anonymous, "POST", `/shared/${shareId}/folders`, {
        name: "x",
        parentId: kit.id,
      })
    ).status,
  ).toBe(404);

  const opened = await stack.api(owner.jar, "PUT", `/nodes/${kit.id}/sharing/link`, {
    linkAccess: "anyone",
  });
  expect(opened.body.sharing).toMatchObject({ shareId, linkAccess: "anyone" });

  const listed = await stack.api(anonymous, "GET", `/shared/${shareId}`);
  expect(listed.status).toBe(200);
  expect(listed.body.item).toMatchObject({
    role: "viewer",
    path: [{ id: kit.id, name: "Press kit" }],
  });
  expect(names(listed.body)).toEqual(["logo.svg"]);
  // No address of anyone it is shared with, no object key, no link id beyond the one they hold.
  const raw = JSON.stringify(listed.body);
  expect(raw).not.toContain(pressEmail);
  expect(raw).not.toMatch(/r2Key|shareId|linkAccess|orgs\//);
  const file = await content(shareId);
  expect(file.status).toBe(200);
  expect(file.headers.get("content-type")).toBe("application/octet-stream");
  expect(file.headers.get("content-disposition")).toContain("attachment");
  expect(file.headers.get("x-content-type-options")).toBe("nosniff");
  expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);
  const slice = await content(shareId, logo.id, { range: "bytes=100-199" });
  expect(slice.status).toBe(206);
  expect(Buffer.from(await slice.arrayBuffer())).toEqual(bytes.subarray(100, 200));

  // Nothing beside the shared folder, and no way to change or inspect it.
  expect((await content(shareId, payroll.id)).status).toBe(404);
  expect((await stack.api(anonymous, "GET", `/shared/${shareId}?node=${payroll.id}`)).status).toBe(
    404,
  );
  const writes = [
    await stack.api(anonymous, "POST", `/shared/${shareId}/folders`, {
      name: "x",
      parentId: kit.id,
    }),
    await stack.api(anonymous, "POST", `/shared/${shareId}/uploads`, {
      name: "x.bin",
      size: 1,
      parentId: kit.id,
    }),
    await stack.api(anonymous, "PATCH", `/shared/${shareId}/nodes/${logo.id}`, { name: "x.svg" }),
    await stack.api(anonymous, "DELETE", `/shared/${shareId}/nodes/${logo.id}`),
  ];
  expect(writes.map((write) => write.status)).toEqual([403, 403, 403, 403]);
  expect((await stack.api(anonymous, "GET", `/nodes/${kit.id}/sharing`)).status).toBe(401);
  expect(names((await stack.api(owner.jar, "GET", `/nodes?parent=${kit.id}`)).body)).toEqual([
    "logo.svg",
  ]);
  expect(
    await stack.db
      .select()
      .from(schema.storageUploads)
      .where(eq(schema.storageUploads.name, "x.bin")),
  ).toEqual([]);

  const reset = await stack.api(owner.jar, "PUT", `/nodes/${kit.id}/sharing/link`, { reset: true });
  const fresh = reset.body.sharing.shareId as string;
  expect(fresh).not.toBe(shareId);
  expect((await stack.api(anonymous, "GET", `/shared/${shareId}`)).status).toBe(404);
  expect((await content(shareId)).status).toBe(404);
  expect((await content(fresh)).status).toBe(200);
  // Back to Restricted closes the new one at once.
  await stack.api(owner.jar, "PUT", `/nodes/${kit.id}/sharing/link`, { linkAccess: "restricted" });
  expect((await content(fresh)).status).toBe(404);
});

// Catches: an Editor who cannot actually upload, one who can write beside the folder they were
// given or take over its sharing, a Viewer who can write, and an upload through a grant that
// lands in (or is counted against) the wrong workspace.
test("an Editor uploads and changes inside the granted folder and nowhere else; a Viewer only reads; neither manages sharing", async () => {
  const { org, ana: owner } = await ana();
  const project = await folder(owner, { space: "personal" }, "Project");
  const other = await folder(owner, { space: "personal" }, "Other");
  const secret = await stack.upload(
    owner.jar,
    { parentId: other.id },
    "secret.txt",
    randomBytes(10),
  );
  const editorEmail = address("editor");
  const viewerEmail = address("viewer");
  const shareId = await share(owner, project.id, editorEmail, "editor");
  await share(owner, project.id, viewerEmail, "viewer");
  const editor = await signedIn(editorEmail);
  const viewer = await signedIn(viewerEmail);
  const base = `/shared/${shareId}`;

  const bytes = randomBytes(4000);
  const uploaded = await stack.upload(
    editor,
    { parentId: project.id },
    "draft.bin",
    bytes,
    undefined,
    base,
  );
  // It is the owner's file, in the owner's workspace, counted there.
  expect(uploaded).toMatchObject({ orgId: org.id, space: "personal", ownerMemberId: owner.id });
  expect(await stack.usedBytes(org.id)).toBe(4010);
  const mine = await stack.download(owner.jar, uploaded.id);
  expect(Buffer.from(await mine.arrayBuffer())).toEqual(bytes);
  const made = await stack.api(editor, "POST", `${base}/folders`, {
    name: "Notes",
    parentId: project.id,
  });
  expect(made.status).toBe(201);
  const renamed = await stack.api(editor, "PATCH", `${base}/nodes/${uploaded.id}`, {
    name: "final.bin",
  });
  expect(renamed).toMatchObject({ status: 200, body: { node: { name: "final.bin" } } });
  const moved = await stack.api(editor, "PATCH", `${base}/nodes/${uploaded.id}`, {
    parentId: made.body.node.id,
  });
  expect(moved).toMatchObject({ status: 200, body: { node: { parentId: made.body.node.id } } });
  expect((await stack.api(editor, "DELETE", `${base}/nodes/${uploaded.id}`)).status).toBe(200);
  expect(names((await stack.api(owner.jar, "GET", "/trash")).body)).toEqual(["final.bin"]);

  // Outside the folder nothing exists for the Editor, as a target or as a destination.
  const outside = [
    await stack.api(editor, "POST", `${base}/folders`, { name: "x", parentId: other.id }),
    await stack.api(editor, "POST", `${base}/folders`, { name: "x", space: "personal" }),
    await stack.api(editor, "POST", `${base}/uploads`, { name: "x", size: 1, parentId: other.id }),
    await stack.api(editor, "PATCH", `${base}/nodes/${secret.id}`, { name: "mine.txt" }),
    await stack.api(editor, "PATCH", `${base}/nodes/${made.body.node.id}`, { parentId: other.id }),
    await stack.api(editor, "DELETE", `${base}/nodes/${secret.id}`),
    await stack.api(editor, "DELETE", `${base}/nodes/${uploaded.id}?forever=1`),
    // The member routes are for members: a grant opens nothing there.
    await stack.api(editor, "POST", "/folders", { name: "x", parentId: project.id }),
    await stack.api(editor, "GET", `/nodes/${project.id}/sharing`),
    await stack.api(editor, "PUT", `/nodes/${project.id}/sharing/link`, { linkAccess: "anyone" }),
    await stack.api(editor, "PUT", `/nodes/${project.id}/sharing/people/${viewerEmail}`, {
      role: "editor",
    }),
    await stack.api(editor, "DELETE", `/nodes/${project.id}/sharing/people/${viewerEmail}`),
  ];
  expect(outside.map((answer) => answer.status)).toEqual(outside.map(() => 404));
  // The folder they were given is not theirs to rename or trash.
  expect(
    (await stack.api(editor, "PATCH", `${base}/nodes/${project.id}`, { name: "Mine" })).status,
  ).toBe(403);
  expect((await stack.api(editor, "DELETE", `${base}/nodes/${project.id}`)).status).toBe(403);

  const refused = [
    await stack.api(viewer, "POST", `${base}/folders`, { name: "x", parentId: project.id }),
    await stack.api(viewer, "POST", `${base}/uploads`, {
      name: "x",
      size: 1,
      parentId: project.id,
    }),
    await stack.api(viewer, "PATCH", `${base}/nodes/${made.body.node.id}`, { name: "x" }),
    await stack.api(viewer, "DELETE", `${base}/nodes/${made.body.node.id}`),
  ];
  expect(refused.map((answer) => answer.status)).toEqual([403, 403, 403, 403]);
  expect(names((await stack.api(viewer, "GET", base)).body)).toEqual(["Notes"]);
  const sharing = await stack.api(owner.jar, "GET", `/nodes/${project.id}/sharing`);
  expect(sharing.body.sharing).toMatchObject({
    linkAccess: "restricted",
    people: [
      { email: editorEmail, role: "editor" },
      { email: viewerEmail, role: "viewer" },
    ],
  });
  expect(
    await stack.api(owner.jar, "PUT", `/nodes/${project.id}/sharing/people/not-an-address`, {
      role: "viewer",
    }),
  ).toMatchObject({
    status: 400,
    body: { code: "invalid_email" },
  });
});

// Catches: an upload opened as Editor that keeps taking parts, completes into a file, or is
// aborted after the person was made a Viewer, because the upload routes checked only that the
// upload was theirs and not that they may still write where it lands.
test("an Editor made Viewer mid-upload can no longer add parts to it, complete it or abort it", async () => {
  const { ana: owner } = await ana();
  const project = await folder(owner, { space: "personal" }, "Project");
  const email = address("downgraded");
  const shareId = await share(owner, project.id, email, "editor");
  const guest = await signedIn(email);
  const base = `/shared/${shareId}`;
  const bytes = randomBytes(3000);
  const opened = await stack.api(guest, "POST", `${base}/uploads`, {
    name: "late.bin",
    size: bytes.length,
    parentId: project.id,
  });
  expect(opened.status).toBe(201);
  const id = opened.body.upload.id as string;

  await share(owner, project.id, email, "viewer");
  expect((await stack.putPart(guest, id, 1, bytes, base)).status).toBe(404);
  expect((await stack.api(guest, "POST", `${base}/uploads/${id}/complete`)).status).toBe(404);
  expect((await stack.api(guest, "DELETE", `${base}/uploads/${id}`)).status).toBe(404);
  expect(names((await stack.api(owner.jar, "GET", `/nodes?parent=${project.id}`)).body)).toEqual(
    [],
  );

  // Made Editor again, the same upload is theirs to finish: refusing it removed nothing.
  await share(owner, project.id, email, "editor");
  expect((await stack.putPart(guest, id, 1, bytes, base)).status).toBe(200);
  const done = await stack.api(guest, "POST", `${base}/uploads/${id}/complete`);
  expect(done).toMatchObject({ status: 200, body: { node: { name: "late.bin" } } });
});

// Catches: whoever controls a company's mail (and so can sign in as its addresses) reaching what
// was shared with a person's own address.
test("a session scoped to a company does not see or open a grant addressed to the person's personal address", async () => {
  const { db } = stack;
  const { ana: owner } = await ana();
  const tag = randomUUID().slice(0, 8);
  const domain = `corp-${tag}.test`;
  const work = `pat@${domain}`;
  const personal = `pat-${tag}@gmail.test`;
  const [pat] = await db
    .insert(schema.users)
    .values({ id: randomUUID(), name: "Pat", email: work, emailVerified: true })
    .returning();
  await db
    .insert(schema.userEmails)
    .values({ userId: pat!.id, email: personal, verifiedAt: new Date() });
  const corp = await createOrg(db, `corp-${tag}`);
  await db.insert(schema.members).values({
    id: randomUUID(),
    organizationId: corp.id,
    userId: pat!.id,
    role: "member",
    createdAt: new Date(),
  });
  await db.insert(schema.mailDomains).values({ orgId: corp.id, domain, provider: "imap" });

  const bytes = randomBytes(100);
  const toPersonal = await stack.upload(owner.jar, { space: "personal" }, "personal.txt", bytes);
  const toWork = await stack.upload(owner.jar, { space: "personal" }, "work.txt", bytes);
  const personalLink = await share(owner, toPersonal.id, personal);
  const workLink = await share(owner, toWork.id, work);
  const shared = async (jar: CookieJar) =>
    (await stack.api(jar, "GET", "/shared-with-me")).body.items
      .map((item: { node: StorageNode }) => item.node.name)
      .toSorted();
  const opens = async (jar: CookieJar, shareId: string, nodeId: string) =>
    (await stack.get(jar, `/shared/${shareId}/files/${nodeId}/content`)).status;

  const scoped = await signedIn(work);
  expect(await shared(scoped)).toEqual(["work.txt"]);
  expect(await opens(scoped, workLink, toWork.id)).toBe(200);
  expect((await stack.api(scoped, "GET", `/shared/${personalLink}`)).status).toBe(404);
  expect(await opens(scoped, personalLink, toPersonal.id)).toBe(404);

  // Pat is also a member of the owner's company: its Shared opens by link for the session that
  // reaches every workspace, and not for the one scoped to the other company.
  await db.insert(schema.members).values({
    id: randomUUID(),
    organizationId: owner.organizationId,
    userId: pat!.id,
    role: "member",
    createdAt: new Date(),
  });
  const team = await folder(owner, { space: "shared" }, "Team");
  const linked = await stack.api(owner.jar, "PUT", `/nodes/${team.id}/sharing/link`, {
    linkAccess: "restricted",
  });
  const teamLink = linked.body.sharing.shareId as string;
  expect((await stack.api(scoped, "GET", `/shared/${teamLink}`)).status).toBe(404);

  const full = await signedIn(personal);
  expect(await shared(full)).toEqual(["personal.txt", "work.txt"]);
  expect((await stack.api(full, "GET", `/shared/${teamLink}`)).status).toBe(200);
  expect(await opens(full, personalLink, toPersonal.id)).toBe(200);
  expect(await opens(full, workLink, toWork.id)).toBe(200);
});

// Catches: something its owner threw away still downloadable by the people and the link it had.
test("a shared item in Trash answers 404 through its grant and its link, and comes back when restored", async () => {
  const { ana: owner } = await ana();
  const kit = await folder(owner, { space: "personal" }, "Kit");
  const file = await stack.upload(owner.jar, { parentId: kit.id }, "plan.pdf", randomBytes(50));
  const guestEmail = address("guest");
  const shareId = await share(owner, kit.id, guestEmail);
  await stack.api(owner.jar, "PUT", `/nodes/${kit.id}/sharing/link`, { linkAccess: "anyone" });
  const guest = await signedIn(guestEmail);
  const statuses = async () => {
    const answers = [];
    for (const jar of [guest, anonymous]) {
      answers.push((await stack.api(jar, "GET", `/shared/${shareId}`)).status);
      answers.push((await stack.get(jar, `/shared/${shareId}/files/${file.id}/content`)).status);
    }
    return answers;
  };
  expect(await statuses()).toEqual([200, 200, 200, 200]);

  // The file inside goes first, then the folder that carries the link.
  expect((await stack.api(owner.jar, "DELETE", `/nodes/${file.id}`)).status).toBe(200);
  expect(await statuses()).toEqual([200, 404, 200, 404]);
  expect((await stack.api(owner.jar, "POST", `/nodes/${file.id}/restore`)).status).toBe(200);
  expect((await stack.api(owner.jar, "DELETE", `/nodes/${kit.id}`)).status).toBe(200);
  expect(await statuses()).toEqual([404, 404, 404, 404]);
  expect((await stack.api(guest, "GET", "/shared-with-me")).body.items).toEqual([]);
  // Sharing is for what is live: in Trash it cannot be opened wider.
  expect(
    (await stack.api(owner.jar, "PUT", `/nodes/${kit.id}/sharing/link`, { linkAccess: "anyone" }))
      .status,
  ).toBe(404);

  expect((await stack.api(owner.jar, "POST", `/nodes/${kit.id}/restore`)).status).toBe(200);
  expect(await statuses()).toEqual([200, 200, 200, 200]);
});
