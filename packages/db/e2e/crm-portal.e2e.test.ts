import { afterAll, expect, test } from "vitest";
import { forMember, forUser } from "../src/for-member.ts";
import { addFile, createPerson, setRole } from "./storage-support.ts";
import { createMember, createOrg, createTestDatabase } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

const ok = <R extends { status: string }>(result: R) => {
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
  return result as Extract<R, { status: "ok" }>;
};

async function studio(slug: string) {
  const org = await createOrg(db, slug);
  const ana = await createMember(db, org.id, "ana");
  await setRole(db, ana.id, "owner");
  const team = forMember(db, ana.id);
  const project = async (name: string) => {
    const deal = ok(await team.crm.createDeal({ name })).deal;
    const milestone = ok(
      await team.crm.createMilestone(deal.id, { title: `${name} design` }),
    ).milestone;
    const folder = ok(await team.crm.dealFolder(deal.id)).nodeId;
    const internal = await addFile(team.storage, { parentId: folder }, `${name}-margins.xlsx`);
    const shown = ok(
      await team.crm.createDeliverable(deal.id, {
        title: `${name} homepage`,
        milestoneId: milestone.id,
        status: "in_review",
        clientVisible: true,
      }),
    ).deliverable;
    const hidden = ok(
      await team.crm.createDeliverable(deal.id, {
        title: `${name} internal draft`,
        nodeId: internal.id,
        status: "in_review",
      }),
    ).deliverable;
    ok(await team.crm.createContract({ title: `${name} SOW draft`, dealId: deal.id }));
    return { deal, folder, internal, shown, hidden };
  };
  return { org, team, website: await project("website"), app: await project("app") };
}

test("a client sees only the projects they are a client on, and only what is meant for them", async () => {
  const { team, website, app } = await studio("portal-scope");
  const bea = await createPerson(db, "bea@client.test");
  const portal = forUser(db, bea.id).crm;
  expect(ok(await portal.projects()).projects).toEqual([]);

  ok(
    await team.crm.grantProjectAccess(website.deal.id, {
      email: "bea@client.test",
      scope: "client",
    }),
  );
  const clientFolder = ok(await portal.project(website.deal.id)).detail.folder!.id;
  const brief = await addFile(team.storage, { parentId: clientFolder }, "brief.pdf");
  ok(await team.crm.updateDeliverable(website.shown.id, { nodeId: brief.id }));

  expect(ok(await portal.projects()).projects.map((p) => p.name)).toEqual(["website"]);
  const detail = ok(await portal.project(website.deal.id)).detail;
  expect(detail.milestones.map((m) => m.title)).toEqual(["website design"]);
  expect(detail.deliverables.map((d) => [d.title, d.file?.name])).toEqual([
    ["website homepage", "brief.pdf"],
  ]);
  expect(detail.contracts).toEqual([]);
  expect(detail.folder?.files.map((f) => f.name)).toEqual(["brief.pdf"]);
  const shareId = detail.folder?.shareId;
  expect(shareId).toEqual(expect.any(String));
  const opened = forUser(db, bea.id).storage.under(shareId!);
  expect((await opened.node(brief.id))?.node.name).toBe("brief.pdf");

  expect((await portal.project(app.deal.id)).status).toBe("not_found");
  expect(
    (await portal.reviewDeliverable(app.deal.id, app.shown.id, { decision: "approve" })).status,
  ).toBe("not_found");
  expect(
    (await portal.reviewDeliverable(website.deal.id, app.shown.id, { decision: "approve" })).status,
  ).toBe("not_found");
  expect(
    (await portal.reviewDeliverable(website.deal.id, website.hidden.id, { decision: "approve" }))
      .status,
  ).toBe("not_found");

  const drive = forUser(db, bea.id).storage;
  expect((await drive.node(brief.id))?.node.name).toBe("brief.pdf");
  expect(await drive.node(website.internal.id)).toBeNull();
  expect(await drive.node(website.folder)).toBeNull();
  expect(await drive.node(app.internal.id)).toBeNull();
  expect(ok(await forUser(db, bea.id, "some-other-org").crm.projects()).projects).toEqual([]);

  ok(await team.crm.revokeProjectAccess(website.deal.id, "bea@client.test"));
  expect(ok(await portal.projects()).projects).toEqual([]);
  expect((await portal.project(website.deal.id)).status).toBe("not_found");
  expect(await drive.node(brief.id)).toBeNull();
});

test("a client approves a deliverable in review once, and asking for changes needs a note", async () => {
  const { team, website } = await studio("portal-review");
  const bea = await createPerson(db, "bea@review.test");
  ok(
    await team.crm.grantProjectAccess(website.deal.id, {
      email: "bea@review.test",
      scope: "client",
    }),
  );
  const portal = forUser(db, bea.id).crm;

  expect(
    await portal.reviewDeliverable(website.deal.id, website.shown.id, {
      decision: "request_changes",
      note: "  ",
    }),
  ).toEqual({ status: "note_required" });
  const approved = ok(
    await portal.reviewDeliverable(website.deal.id, website.shown.id, { decision: "approve" }),
  ).detail.deliverables[0]!;
  expect(approved).toMatchObject({ status: "approved", reviewedByEmail: "bea@review.test" });
  expect(
    await portal.reviewDeliverable(website.deal.id, website.shown.id, { decision: "approve" }),
  ).toEqual({ status: "not_in_review" });

  ok(await team.crm.updateDeliverable(website.shown.id, { status: "in_review" }));
  const changes = ok(
    await portal.reviewDeliverable(website.deal.id, website.shown.id, {
      decision: "request_changes",
      note: "Bigger logo",
    }),
  ).detail.deliverables[0]!;
  expect(changes).toMatchObject({ status: "changes_requested", reviewNote: "Bigger logo" });
  const seen = ok(await team.crm.plan(website.deal.id)).plan.deliverables;
  expect(seen.find((d) => d.id === website.shown.id)?.status).toBe("changes_requested");
});

test("a freelancer turned client loses the project's folder", async () => {
  const { org, team, website } = await studio("portal-switch");
  const fran = await createPerson(db, "fran@switch.test");
  ok(
    await team.crm.grantProjectAccess(website.deal.id, {
      email: "fran@switch.test",
      scope: "freelancer",
    }),
  );
  const drive = forUser(db, fran.id).storage;
  expect((await drive.node(website.internal.id))?.node.name).toBe("website-margins.xlsx");
  ok(
    await team.crm.grantProjectAccess(website.deal.id, {
      email: "fran@switch.test",
      scope: "client",
    }),
  );
  expect(await drive.node(website.internal.id)).toBeNull();
  expect(ok(await forUser(db, fran.id).crm.projects()).projects.map((p) => p.orgId)).toEqual([
    org.id,
  ]);
});

test("a client folder replaced after Trash still opens to every client, and not to one removed", async () => {
  const { team, website } = await studio("portal-trash");
  const [bea, cleo] = await Promise.all([
    createPerson(db, "bea@trash.test"),
    createPerson(db, "cleo@trash.test"),
  ]);
  for (const email of ["bea@trash.test", "cleo@trash.test"]) {
    ok(await team.crm.grantProjectAccess(website.deal.id, { email, scope: "client" }));
  }
  const old = ok(await forUser(db, bea.id).crm.project(website.deal.id)).detail.folder!.id;
  const kept = await addFile(team.storage, { parentId: old }, "old-brief.pdf");
  ok(await team.storage.trash(old));
  ok(await team.crm.revokeProjectAccess(website.deal.id, "bea@trash.test"));

  ok(
    await team.crm.grantProjectAccess(website.deal.id, {
      email: "dan@trash.test",
      scope: "client",
    }),
  );
  const fresh = ok(await forUser(db, cleo.id).crm.project(website.deal.id)).detail.folder!;
  expect(fresh.id).not.toBe(old);
  const brief = await addFile(team.storage, { parentId: fresh.id }, "brief.pdf");
  expect((await forUser(db, cleo.id).storage.node(brief.id))?.node.name).toBe("brief.pdf");

  ok(await team.crm.revokeProjectAccess(website.deal.id, "cleo@trash.test"));
  ok(await team.storage.restore(old));
  expect(await forUser(db, bea.id).storage.node(kept.id)).toBeNull();
  expect(await forUser(db, cleo.id).storage.node(kept.id)).toBeNull();
});
