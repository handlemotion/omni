import { afterAll, beforeAll, expect, test } from "vitest";
import { startCrmStack, type CrmStack } from "./crm-support.ts";

let stack: CrmStack;

beforeAll(async () => {
  stack = await startCrmStack();
}, 60_000);

afterAll(async () => {
  await stack?.stop();
});

type Jar = Parameters<CrmStack["api"]>[0];

async function everyPage(jar: Jar, path: string, key: string) {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 20; pages++) {
    const join = path.includes("?") ? "&" : "?";
    const page = await stack.api(
      jar,
      "GET",
      `${path}${cursor ? `${join}cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    expect(page.status).toBe(200);
    ids.push(...(page.body[key] as { id: string }[]).map((row) => row.id));
    cursor = page.body.nextCursor;
    if (!cursor) break;
  }
  return ids;
}

test("deals sorted by value page through every deal once, biggest first and unvalued last", async () => {
  const acme = await stack.company("acme-sort");
  const ana = await stack.member(acme.id);
  const values = [500, null, 900, 900, 100, null, 300];
  const made: { id: string; value: number | null }[] = [];
  for (const [i, value] of values.entries()) {
    const deal = await stack.api(ana.jar, "POST", "/deals", {
      name: `Deal ${i}`,
      ...(value === null ? {} : { valueMinor: value, currency: "USD" }),
    });
    made.push({ id: deal.body.deal.id, value });
  }

  const ids = await everyPage(ana.jar, "/deals?sort=value&dir=desc&limit=2", "deals");

  expect(ids).toHaveLength(values.length);
  expect(new Set(ids).size).toBe(values.length);
  const order = ids.map((id) => made.find((deal) => deal.id === id)!.value);
  expect(order).toEqual([900, 900, 500, 300, 100, null, null]);
});

test("a name cursor from an older Worker keeps paging the name-ordered list", async () => {
  const acme = await stack.company("acme-cursor");
  const ana = await stack.member(acme.id);
  for (const name of ["Bravo", "Alpha", "Charlie"]) {
    await stack.api(ana.jar, "POST", "/companies", { name });
  }
  const alpha = (await stack.api(ana.jar, "GET", "/companies?limit=1")).body.companies[0];
  const legacy = Buffer.from(JSON.stringify({ name: alpha.name, id: alpha.id })).toString(
    "base64url",
  );

  const next = await stack.api(ana.jar, "GET", `/companies?limit=5&cursor=${legacy}`);

  expect(next.status).toBe(200);
  expect(next.body.companies.map((c: { name: string }) => c.name)).toEqual(["Bravo", "Charlie"]);
});

test("filters combine: unowned companies, people without a company, deals closing in a window", async () => {
  const acme = await stack.company("acme-filter");
  const ana = await stack.member(acme.id);
  const bea = await stack.member(acme.id);
  await stack.api(ana.jar, "POST", "/companies", { name: "Mine" });
  await stack.api(ana.jar, "POST", "/companies", { name: "Nobody's", ownerMemberId: null });
  await stack.api(ana.jar, "POST", "/companies", { name: "Bea's", ownerMemberId: bea.id });
  await stack.api(ana.jar, "POST", "/people", { name: "Gail", address: "gail@gmail.com" });
  await stack.api(ana.jar, "POST", "/people", { name: "Ivo", address: "ivo@initech.com" });
  for (const [name, expectedCloseOn] of [
    ["Early", "2026-11-01"],
    ["Inside", "2026-12-10"],
    ["Late", "2027-02-01"],
    ["Undated", null],
  ] as const) {
    await stack.api(ana.jar, "POST", "/deals", { name, expectedCloseOn });
  }

  const unowned = await stack.api(ana.jar, "GET", "/companies?owner=none");
  const beas = await stack.api(ana.jar, "GET", `/companies?owner=${bea.id}`);
  const loose = await stack.api(ana.jar, "GET", "/people?hasCompany=0");
  const window = await stack.api(
    ana.jar,
    "GET",
    "/deals?closeAfter=2026-12-01&closeBefore=2026-12-31",
  );

  const names = (rows: { name: string }[]) => rows.map((row) => row.name);
  expect(names(unowned.body.companies)).toEqual(["Initech", "Nobody's"]);
  expect(names(beas.body.companies)).toEqual(["Bea's"]);
  expect(names(loose.body.people)).toEqual(["Gail"]);
  expect(names(window.body.deals)).toEqual(["Inside"]);
  expect(window.body.deals[0].expectedCloseOn).toBe("2026-12-10");
});

test("an archived company comes back with restore, into the list and its timeline", async () => {
  const acme = await stack.company("acme-restore");
  const ana = await stack.member(acme.id);
  const initech = (await stack.api(ana.jar, "POST", "/companies", { name: "Initech" })).body
    .company;
  await stack.api(ana.jar, "DELETE", `/companies/${initech.id}`);
  const archived = await stack.api(ana.jar, "GET", "/companies?archived=only");
  expect(archived.body.companies.map((c: { id: string }) => c.id)).toEqual([initech.id]);
  expect((await stack.api(ana.jar, "GET", "/companies")).body.companies).toEqual([]);

  const restored = await stack.api(ana.jar, "POST", `/companies/${initech.id}/restore`);

  expect(restored.status).toBe(200);
  expect(restored.body.company.archivedAt).toBeNull();
  const listed = await stack.api(ana.jar, "GET", "/companies");
  expect(listed.body.companies.map((c: { id: string }) => c.id)).toEqual([initech.id]);
  const timeline = await stack.api(ana.jar, "GET", `/companies/${initech.id}/timeline`);
  const kinds = timeline.body.items
    .filter((item: { kind: string }) => item.kind === "event")
    .map((item: { event: { kind: string } }) => item.event.kind);
  expect(kinds).toEqual(["restored", "archived", "created"]);
});

test("bulk delete holds each record to its own rules: a member is refused, an admin deletes", async () => {
  const acme = await stack.company("acme-bulk");
  const ana = await stack.member(acme.id);
  const owner = await stack.member(acme.id, "owner");
  const ids: string[] = [];
  for (const name of ["One", "Two", "Three"]) {
    ids.push((await stack.api(ana.jar, "POST", "/deals", { name })).body.deal.id);
  }
  const otherWorkspace = await stack.company("beta-bulk");
  const cid = await stack.member(otherWorkspace.id);
  const theirs = (await stack.api(cid.jar, "POST", "/deals", { name: "Theirs" })).body.deal.id;

  const byMember = await stack.api(ana.jar, "POST", "/deals/bulk", {
    ids,
    action: { action: "delete" },
  });
  const byOwner = await stack.api(owner.jar, "POST", "/deals/bulk", {
    ids: [...ids, theirs],
    action: { action: "delete" },
  });

  expect(byMember.body).toEqual({
    done: [],
    refused: ids.map((id) => ({ id, code: "forbidden" })),
  });
  expect(byOwner.body).toEqual({ done: ids, refused: [{ id: theirs, code: "not_found" }] });
  expect((await stack.api(ana.jar, "GET", "/deals")).body.deals).toEqual([]);
  expect((await stack.api(cid.jar, "GET", "/deals")).body.deals).toHaveLength(1);
});

test("bulk stage moves deals by the stage rules, and companies refuse a stage", async () => {
  const acme = await stack.company("acme-bulk-stage");
  const ana = await stack.member(acme.id);
  const stages = (await stack.api(ana.jar, "GET", "/stages")).body.stages as {
    id: string;
    kind: string;
  }[];
  const won = stages.find((stage) => stage.kind === "won")!;
  const a = (await stack.api(ana.jar, "POST", "/deals", { name: "A" })).body.deal.id;
  const b = (await stack.api(ana.jar, "POST", "/deals", { name: "B" })).body.deal.id;

  const moved = await stack.api(ana.jar, "POST", "/deals/bulk", {
    ids: [a, b],
    action: { action: "stage", stageId: won.id },
  });
  const projects = await stack.api(ana.jar, "GET", "/deals?kind=won");
  const companies = await stack.api(ana.jar, "POST", "/companies/bulk", {
    ids: [a],
    action: { action: "stage", stageId: won.id },
  });

  expect(moved.body.done).toEqual([a, b]);
  expect(projects.body.deals.map((d: { wonAt: string | null }) => Boolean(d.wonAt))).toEqual([
    true,
    true,
  ]);
  expect(companies.status).toBe(400);
});

test("a person's page lists their live deals, and an owner from another workspace is refused", async () => {
  const acme = await stack.company("acme-person-deals");
  const ana = await stack.member(acme.id);
  const beta = await stack.company("beta-person-deals");
  const cid = await stack.member(beta.id);
  const carla = (
    await stack.api(ana.jar, "POST", "/people", { name: "Carla", address: "carla@northwind.com" })
  ).body.person;
  const live = (
    await stack.api(ana.jar, "POST", "/deals", { name: "Website", personIds: [carla.id] })
  ).body.deal;
  const gone = (await stack.api(ana.jar, "POST", "/deals", { name: "Old", personIds: [carla.id] }))
    .body.deal;
  await stack.api(ana.jar, "DELETE", `/deals/${gone.id}`);

  const detail = await stack.api(ana.jar, "GET", `/people/${carla.id}`);
  const foreignOwner = await stack.api(ana.jar, "PATCH", `/people/${carla.id}`, {
    ownerMemberId: cid.id,
  });

  expect(detail.body.deals.map((d: { id: string }) => d.id)).toEqual([live.id]);
  expect(foreignOwner.status).toBe(404);
});
