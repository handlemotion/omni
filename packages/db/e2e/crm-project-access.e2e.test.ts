import { randomUUID } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import { forMember, forUser } from "../src/for-member.ts";
import { members } from "../src/schema/index.ts";
import { addFile, createPerson, setRole } from "./storage-support.ts";
import { createMember, createOrg, createTestDatabase } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

const ok = <R extends { status: string }>(result: R) => {
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
  return result as Extract<R, { status: "ok" }>;
};

async function freelancer(orgId: string, email: string) {
  const user = await createPerson(db, email);
  const [member] = await db
    .insert(members)
    .values({
      id: randomUUID(),
      organizationId: orgId,
      userId: user.id,
      role: "freelancer",
      createdAt: new Date(),
    })
    .returning();
  return { user, member: member!, door: forMember(db, member!.id), as: forUser(db, user.id) };
}

async function studio(slug: string) {
  const org = await createOrg(db, slug);
  const ana = await createMember(db, org.id, "ana");
  await setRole(db, ana.id, "owner");
  const team = forMember(db, ana.id);
  const project = async (name: string, client: string) => {
    const person = ok(
      await team.crm.addPerson({ name: client, address: `${client}@${name}.test` }),
    );
    const deal = ok(
      await team.crm.createDeal({
        name,
        companyId: person.person.companyId!,
        personIds: [person.person.id],
      }),
    ).deal;
    ok(await team.crm.createMilestone(deal.id, { title: `${name} kickoff` }));
    ok(await team.crm.createNote({ record: { dealId: deal.id }, body: `${name} budget is fixed` }));
    const task = ok(
      await team.crm.createTask({ title: `${name} task`, record: { dealId: deal.id } }),
    );
    const folder = ok(await team.crm.dealFolder(deal.id)).nodeId;
    const file = await addFile(team.storage, { parentId: folder }, `${name}.pdf`);
    return { deal, person: person.person, task: task.task, folder, file };
  };
  const website = await project("website", "bea");
  const app = await project("app", "carl");
  const sharedFile = await addFile(team.storage, { space: "shared" }, "pricing.xlsx");
  return { org, team, website, app, sharedFile };
}

test("a freelancer reaches only the projects they were added to, in the CRM and in Drive", async () => {
  const { org, team, website, app, sharedFile } = await studio("access-freelancer");
  const { door, as } = await freelancer(org.id, "fran@studio.test");
  const crm = door.crm;

  expect(ok(await crm.listDeals()).deals).toEqual([]);
  expect((await crm.deal(website.deal.id)).status).toBe("not_found");

  const added = ok(
    await team.crm.grantProjectAccess(website.deal.id, {
      email: "Fran@Studio.test",
      scope: "freelancer",
    }),
  );
  expect(added.access).toMatchObject([{ email: "fran@studio.test", scope: "freelancer" }]);

  expect(ok(await crm.listDeals()).deals.map((d) => d.name)).toEqual(["website"]);
  expect(ok(await crm.deal(website.deal.id)).deal.name).toBe("website");
  expect(ok(await crm.plan(website.deal.id)).plan.milestones.map((m) => m.title)).toEqual([
    "website kickoff",
  ]);
  expect(ok(await crm.notes({ dealId: website.deal.id })).items).toEqual([]);
  expect(
    ok(await crm.listTasks({ record: { dealId: website.deal.id } })).tasks.map((t) => t.title),
  ).toEqual(["website task"]);
  ok(await crm.createMilestone(website.deal.id, { title: "Handoff" }));
  expect(ok(await crm.dealFolder(website.deal.id)).nodeId).toBe(website.folder);
  ok(await crm.linkFiles({ dealId: website.deal.id }, [website.file.id]));
  expect(
    ok(await crm.fileLinks({ dealId: website.deal.id })).links.map((l) => l.node.name),
  ).toEqual(["website.pdf"]);
  ok(await crm.createDeliverable(website.deal.id, { title: "PDF", nodeId: website.file.id }));
  expect((await door.storage.node(website.file.id))?.node.name).toBe("website.pdf");
  expect(ok(await crm.listDeals({ archivedOnly: true })).deals).toEqual([]);
  expect(ok(await crm.listDeals({ q: "app" })).deals).toEqual([]);
  ok(await crm.createNote({ record: { dealId: website.deal.id }, body: "Fonts are licensed" }));

  expect((await crm.deal(app.deal.id)).status).toBe("not_found");
  expect((await crm.plan(app.deal.id)).status).toBe("not_found");
  expect((await crm.notes({ dealId: app.deal.id })).status).toBe("not_found");
  expect((await crm.events({ dealId: app.deal.id })).status).toBe("not_found");
  expect((await crm.task(app.task.id)).status).toBe("not_found");
  expect((await crm.updateTask(app.task.id, { title: "mine" })).status).toBe("not_found");
  expect((await crm.updateTask(website.task.id, { record: { dealId: app.deal.id } })).status).toBe(
    "not_found",
  );
  expect((await crm.createMilestone(app.deal.id, { title: "x" })).status).toBe("not_found");
  expect((await crm.dealFolder(app.deal.id)).status).toBe("not_found");
  expect((await crm.fileLinks({ dealId: app.deal.id })).status).toBe("not_found");
  expect((await crm.listContracts({ dealId: app.deal.id })).status).toBe("not_found");
  expect(ok(await crm.listTasks()).tasks).toEqual([]);
  expect(ok(await crm.listTasks({ record: { dealId: app.deal.id } })).tasks).toEqual([]);
  const found = ok(await crm.search({ q: "app" }));
  expect([found.people, found.companies, found.deals]).toEqual([[], [], []]);
  const looked = ok(await crm.lookup({ addresses: ["carl@app.test", "bea@website.test"] }));
  expect([looked.people, looked.companies]).toEqual([[], []]);
  expect(looked.deals.map((d) => d.name)).toEqual(["website"]);

  expect((await crm.company(app.person.companyId!)).status).toBe("not_found");
  expect((await crm.company(website.person.companyId!)).status).toBe("not_found");
  expect((await crm.person(app.person.id)).status).toBe("not_found");
  expect((await crm.listCompanies()).status).toBe("not_found");
  expect((await crm.listPeople()).status).toBe("not_found");
  expect((await crm.createDeal({ name: "side project" })).status).toBe("not_found");
  expect((await crm.updateDeal(website.deal.id, { name: "renamed" })).status).toBe("not_found");
  expect(
    (await crm.grantProjectAccess(app.deal.id, { email: "fran@studio.test", scope: "freelancer" }))
      .status,
  ).toBe("not_found");
  expect(await crm.bulk("deals", [app.deal.id, website.deal.id], { action: "archive" })).toEqual({
    status: "ok",
    done: [],
    refused: [
      { id: app.deal.id, status: "not_found" },
      { id: website.deal.id, status: "not_found" },
    ],
  });

  expect((await door.storage.list({ space: "shared" })).status).toBe("not_found");
  expect(await door.storage.node(sharedFile.id)).toBeNull();
  expect(await door.storage.node(app.file.id)).toBeNull();
  expect(await as.storage.node(app.file.id)).toBeNull();
  expect(await as.storage.node(sharedFile.id)).toBeNull();
  expect((await as.storage.node(website.file.id))?.node.name).toBe("website.pdf");
  const shared = (await as.storage.sharedWithMe()).items;
  expect(shared.map((item) => [item.node.id, item.role])).toEqual([[website.folder, "editor"]]);

  ok(await team.crm.revokeProjectAccess(website.deal.id, "fran@studio.test"));
  expect((await crm.deal(website.deal.id)).status).toBe("not_found");
  expect(ok(await crm.listDeals()).deals).toEqual([]);
  expect(await as.storage.node(website.file.id)).toBeNull();
});

test("a client on a project is not a freelancer: membership as one opens nothing", async () => {
  const { org, team, website } = await studio("access-client-row");
  const { door } = await freelancer(org.id, "bea@website.test");
  ok(
    await team.crm.grantProjectAccess(website.deal.id, {
      email: "bea@website.test",
      scope: "client",
    }),
  );
  expect((await door.crm.deal(website.deal.id)).status).toBe("not_found");
  expect(ok(await door.crm.listDeals()).deals).toEqual([]);
  expect(await door.storage.node(website.file.id)).toBeNull();
});

test("a teammate is never added to a project, and a bad address is refused", async () => {
  const { org, team, website } = await studio("access-teammate");
  const ben = await createPerson(db, "ben@studio.test");
  await db
    .insert(members)
    .values({ id: randomUUID(), organizationId: org.id, userId: ben.id, createdAt: new Date() });

  expect(
    await team.crm.grantProjectAccess(website.deal.id, {
      email: "BEN@studio.test",
      scope: "freelancer",
    }),
  ).toEqual({ status: "already_teammate" });
  expect(
    await team.crm.grantProjectAccess(website.deal.id, {
      email: "not an address",
      scope: "client",
    }),
  ).toEqual({ status: "invalid_email" });
  expect(ok(await team.crm.projectAccess(website.deal.id)).access).toEqual([]);
});

test("another workspace cannot add itself to a project", async () => {
  const { website } = await studio("access-leak");
  const other = await createOrg(db, "access-leak-other");
  const eve = forMember(db, (await createMember(db, other.id, "eve")).id).crm;
  expect(
    (await eve.grantProjectAccess(website.deal.id, { email: "eve@evil.test", scope: "freelancer" }))
      .status,
  ).toBe("not_found");
  expect((await eve.projectAccess(website.deal.id)).status).toBe("not_found");
});

test("a freelancer finds their project however many others share its name", async () => {
  const { org, team, website } = await studio("access-crowd");
  const { door } = await freelancer(org.id, "fran@crowd.test");
  for (let n = 0; n < 50; n++) {
    ok(await team.crm.createDeal({ name: `web ${String(n).padStart(2, "0")}` }));
  }
  ok(
    await team.crm.grantProjectAccess(website.deal.id, {
      email: "fran@crowd.test",
      scope: "freelancer",
    }),
  );
  expect(ok(await door.crm.search({ q: "web" })).deals.map((d) => d.name)).toEqual(["website"]);
});

test("removing a freelancer while the project's folder is in Trash still takes it away", async () => {
  const { org, team, website } = await studio("access-trash");
  const { as } = await freelancer(org.id, "fran@trash.test");
  ok(
    await team.crm.grantProjectAccess(website.deal.id, {
      email: "fran@trash.test",
      scope: "freelancer",
    }),
  );
  ok(await team.storage.trash(website.folder));
  ok(await team.crm.revokeProjectAccess(website.deal.id, "fran@trash.test"));
  ok(await team.storage.restore(website.folder));
  expect(await as.storage.node(website.file.id)).toBeNull();
});

test("a freelancer cannot share a file still uploading into their project", async () => {
  const { org, team, website } = await studio("access-upload-link");
  const { door } = await freelancer(org.id, "fran@upload.test");
  ok(
    await team.crm.grantProjectAccess(website.deal.id, {
      email: "fran@upload.test",
      scope: "freelancer",
    }),
  );
  const opened = ok(
    await door.storage.openUpload(
      { parentId: website.folder },
      { name: "cut.mp4", size: 100, mimeType: "video/mp4", limitBytes: null },
    ),
  );
  expect(await door.storage.setUploadLinkAccess(opened.upload.id, "anyone")).toEqual({
    status: "forbidden",
  });
  expect(await door.storage.uploadSharing(opened.upload.id)).toEqual({ status: "forbidden" });
});

test("Drive search offers a freelancer only their projects' files, before anything is opened", async () => {
  const { org, team } = await studio("access-search");
  const { as } = await freelancer(org.id, "fran@search.test");
  const website = ok(await team.crm.listDeals({})).deals.find((d) => d.name === "website")!;
  ok(
    await team.crm.grantProjectAccess(website.id, {
      email: "fran@search.test",
      scope: "freelancer",
    }),
  );
  const names = async (query: string) =>
    (await as.storage.context.wordMatches(query, { limit: 20 })).map((f) => f.name);
  expect(await names("pdf")).toEqual(["website.pdf"]);
  expect(await names("pricing")).toEqual([]);
});

test("a freelancer who can only view a file cannot cancel its signature request", async () => {
  const { org, team } = await studio("access-void");
  const { door } = await freelancer(org.id, "fran@void.test");
  const folder = ok(await team.storage.createFolder({ space: "shared" }, "Contracts")).node;
  const opened = ok(
    await team.storage.openUpload(
      { parentId: folder.id },
      { name: "sow.pdf", size: 4, mimeType: "application/pdf", limitBytes: null },
    ),
  );
  await team.storage.recordUploadPart(opened.upload.id, { partNumber: 1, etag: "e", size: 4 });
  const file = ok(await team.storage.completeUpload(opened.upload.id, { limitBytes: null })).node;
  const sent = ok(
    await team.storage.sendForSignature(file.id, {
      contentVersion: file.contentVersion,
      sha256: "0".repeat(64),
      signers: [{ email: "client@void.test", name: "Client" }],
      origin: { email: "ana@void.test", ip: null, userAgent: null },
    }),
  );
  ok(await team.storage.putGrant(folder.id, "fran@void.test", "viewer"));
  expect((await door.storage.node(file.id))?.node.name).toBe("sow.pdf");
  const origin = { email: "fran@void.test", ip: null, userAgent: null };
  expect(await door.storage.voidSignature(sent.request.id, origin)).toEqual({
    status: "not_found",
  });
});
