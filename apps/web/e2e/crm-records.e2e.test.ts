import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { schema } from "@omni/db";
import { eq, inArray } from "drizzle-orm";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
  grant,
  seedMessage,
  signIn,
  startMailServiceEndpoint,
  startWorkerWithNetwork,
  SYSTEM_MAIL_FROM,
  type TestDb,
} from "../../worker/e2e/support.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: TestDb;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorkerWithNetwork>>;
let browser: Browser;
const SHOTS = process.env.OMNI_E2E_SHOTS;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
const contexts: BrowserContext[] = [];

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
  mailService = await startMailServiceEndpoint();
  const port = await freePort();
  worker = await startWorkerWithNetwork({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    port,
    vars: { BETTER_AUTH_URL: `http://127.0.0.1:${port}`, RATE_LIMIT_AUTH: "off" },
  });
  const system = await createOrg(db, "system");
  await createMailbox(db, system.id, SYSTEM_MAIL_FROM);
  browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
});

afterAll(async () => {
  for (const context of contexts) await context.close();
  await browser?.close();
  await worker?.close();
  await mailService?.close();
  await database?.teardown();
});

test("a deal value saves in a workspace with no default currency", async () => {
  const team = await workspace("currency");
  const { deal } = await team.api("POST", "/deals", { name: "Website rebuild" });
  const settings = await team.api("GET", "/settings");
  expect(settings.settings.defaultCurrency).toBeNull();

  const page = await team.page(`/crm/deals/${deal.id}`);
  const value = page.getByRole("textbox", { name: "Value", exact: true });
  await value.fill("12500");
  await value.press("Enter");

  await expect
    .poll(() => dealRow(deal.id), { timeout: 10_000 })
    .toMatchObject({
      valueMinor: 1_250_000,
      valueCurrency: "USD",
    });
  await expect.poll(() => value.inputValue()).toBe("12,500");
  expect(await page.getByText("$12,500").count()).toBe(0);
});

test("a deal's close date is cleared from inside its calendar", async () => {
  const team = await workspace("deal-close");
  const { deal } = await team.api("POST", "/deals", { name: "Renewal" });
  await db
    .update(schema.crmDeals)
    .set({ expectedCloseOn: "2026-12-11" })
    .where(eq(schema.crmDeals.id, deal.id));
  const page = await team.page(`/crm/deals/${deal.id}`);
  await page.getByText("Dec 11, 2026").click();
  await page.getByRole("grid").waitFor();
  const clear = page.getByRole("button", { name: "Clear date" });
  await expect.poll(async () => (await clear.boundingBox())?.y ?? null).not.toBeNull();
  await page.waitForTimeout(200);
  await clear.click();
  await expect
    .poll(
      async () => {
        const [row] = await db
          .select({ day: schema.crmDeals.expectedCloseOn })
          .from(schema.crmDeals)
          .where(eq(schema.crmDeals.id, deal.id));
        return row?.day ?? null;
      },
      { timeout: 10_000 },
    )
    .toBeNull();
  expect(await page.getByRole("button", { name: "Clear date" }).count()).toBe(0);
});

test("a deal's company is picked in place from its sidebar", async () => {
  const team = await workspace("deal-company");
  await team.api("POST", "/companies", { name: "Acme" });
  const { company } = await team.api("POST", "/companies", { name: "Globex" });
  const { deal } = await team.api("POST", "/deals", { name: "Rebrand" });

  const page = await team.page(`/crm/deals/${deal.id}`);
  const field = page.getByRole("combobox", { name: "Company" });
  await field.fill("Glob");
  await page.getByRole("option", { name: "Globex" }).click();

  await expect
    .poll(() => dealRow(deal.id), { timeout: 10_000 })
    .toMatchObject({ companyId: company.id });
  await expect.poll(() => field.inputValue()).toBe("Globex");
  await page.getByRole("link", { name: "Open Globex" }).waitFor();
});

test("sorting the board by value orders each stage's cards and persists in the URL", async () => {
  const team = await workspace("sort");
  for (const [name, value] of [
    ["Small", 100],
    ["Large", 900],
    ["Medium", 500],
  ] as const) {
    await team.api("POST", "/deals", { name, valueMinor: value * 100, currency: "USD" });
  }
  const page = await team.page("/crm/deals?sort=value&dir=asc");
  await card(page, "Small").waitFor();
  expect(await boardOrder(page)).toEqual(["Small", "Medium", "Large"]);
  await page.reload();
  await card(page, "Small").waitFor();
  expect(await boardOrder(page)).toEqual(["Small", "Medium", "Large"]);
  expect(new URL(page.url()).searchParams.get("sort")).toBe("value");
});

test("bulk archive moves the selected companies to the archived view and restore brings them back", async () => {
  const team = await workspace("bulk");
  const ids: string[] = [];
  for (const name of ["Acme", "Globex", "Initech"]) {
    ids.push((await team.api("POST", "/companies", { name })).company.id);
  }
  const page = await team.page("/crm/companies");
  await pick(page, "Acme");
  await pick(page, "Globex");
  await page.getByText("2 selected").waitFor();
  await page.getByRole("button", { name: "Archive", exact: true }).click();

  await page.getByRole("row", { name: /Acme/ }).waitFor({ state: "detached" });
  expect(await names(page)).toEqual(["Initech"]);
  const archived = await db
    .select({ name: schema.crmCompanies.name, archivedAt: schema.crmCompanies.archivedAt })
    .from(schema.crmCompanies)
    .where(inArray(schema.crmCompanies.id, ids));
  expect(archived.filter((c) => c.archivedAt).map((c) => c.name)).toEqual(
    expect.arrayContaining(["Acme", "Globex"]),
  );

  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Archived/ }).click();
  await page.getByRole("menuitemradio", { name: "Only" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("archived")).toBe("only");
  await expect.poll(() => names(page)).toEqual(["Acme", "Globex"]);
  await pick(page, "Acme");
  await page.getByRole("checkbox", { name: "Select All", exact: true }).click({ force: true });
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await page.getByRole("row", { name: /Globex/ }).waitFor({ state: "detached" });

  await resetFilters(page);
  await expect.poll(() => names(page)).toEqual(["Acme", "Globex", "Initech"]);
});

test("a selection is dropped when a filter changes the view, and stays gone when the filter is removed", async () => {
  const team = await workspace("bulk-view");
  for (const name of ["Acme", "Globex"]) await team.api("POST", "/companies", { name });
  const page = await team.page("/crm/companies");
  await pick(page, "Acme");
  await page.getByText("1 selected").waitFor();

  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Archived/ }).click();
  await page.getByRole("menuitemradio", { name: "Only" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("archived")).toBe("only");
  await resetFilters(page);
  await page.getByRole("row", { name: /Acme/ }).waitFor();

  expect(await page.getByText("1 selected").count()).toBe(0);
  expect(await page.getByRole("row", { name: /Acme/ }).getByRole("checkbox").isChecked()).toBe(
    false,
  );
});

test("the company filter narrows the people list and removing its chip lists everyone again", async () => {
  const team = await workspace("filter");
  const { company } = await team.api("POST", "/companies", { name: "Initech" });
  await team.api("POST", "/people", {
    name: "Ivo",
    address: "ivo@initech.test",
    companyId: company.id,
  });
  await team.api("POST", "/people", { name: "Gail", address: "gail@gmail.com" });
  const page = await team.page("/crm/people");
  await page.getByRole("row", { name: /Gail/ }).waitFor();

  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Company/ }).click();
  await page.getByRole("menuitemradio", { name: "None" }).click();

  await expect.poll(() => new URL(page.url()).searchParams.get("company")).toBe("without");
  await expect.poll(() => names(page)).toEqual(["Gail"]);
  await page.reload();
  await page.getByRole("row", { name: /Gail/ }).waitFor();
  expect(await names(page)).toEqual(["Gail"]);

  await resetFilters(page);
  await expect.poll(() => names(page)).toEqual(["Gail", "Ivo"]);
});

test("the deal board shows only the owner's deals when filtered by owner", async () => {
  const team = await workspace("board");
  const bea = await createMember(db, team.orgId, `bea-${Date.now()}@crm.test`);
  await team.api("POST", "/deals", { name: "Ana's deal" });
  await team.api("POST", "/deals", { name: "Bea's deal", ownerMemberId: bea.id });

  const page = await team.page(`/crm/deals?owner=${bea.id}`);
  await card(page, "Bea's deal").waitFor();
  expect(await card(page, "Ana's deal").count()).toBe(0);
  await resetFilters(page);
  await card(page, "Ana's deal").waitFor();
});

test("a value range is cleared on its own by applying it empty, and the owner filter stays", async () => {
  const team = await workspace("range");
  await team.api("POST", "/deals", { name: "Small deal", valueMinor: 10_000, currency: "USD" });
  await team.api("POST", "/deals", { name: "Big deal", valueMinor: 900_000, currency: "USD" });
  const page = await team.page(`/crm/deals?minValue=1000&owner=${team.memberId}`);
  await card(page, "Big deal").waitFor();
  expect(await card(page, "Small deal").count()).toBe(0);

  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Value/ }).click();
  const dialog = page.getByRole("dialog", { name: "Value" });
  await dialog.getByRole("textbox", { name: "At least" }).fill("");
  await dialog.getByRole("button", { name: "Apply" }).click();

  await expect.poll(() => new URL(page.url()).searchParams.get("minValue")).toBeNull();
  expect(new URL(page.url()).searchParams.get("owner")).toBe(team.memberId);
  await card(page, "Small deal").waitFor();
});

test("a deal moves to the next stage from the keyboard: Space, Right arrow, Space", async () => {
  const team = await workspace("board-keys");
  const { stages } = await team.api("GET", "/stages");
  const [lead, next] = stages as { id: string; name: string }[];
  const { deal } = await team.api("POST", "/deals", { name: "Keyed deal", stageId: lead!.id });
  const page = await team.page("/crm/deals");
  await card(page, "Keyed deal").getByRole("link").focus();
  const resting = await page.getByText("Keyed deal").count();
  await page.keyboard.press("Space");
  await expect.poll(() => page.getByText("Keyed deal").count()).toBe(resting + 1);
  await page.keyboard.press("ArrowRight");
  await page
    .getByRole("region", { name: next!.name, exact: true })
    .and(page.locator("[data-taking]"))
    .waitFor();
  await page.keyboard.press("Space");
  await expect
    .poll(() => dealRow(deal.id), { timeout: 10_000 })
    .toMatchObject({ stageId: next!.id });
  expect(new URL(page.url()).pathname).toMatch(/\/crm\/deals$/);
});

test("the board falls back to name order for a sort it doesn't offer, and has no list view", async () => {
  const team = await workspace("board-sort");
  await team.api("POST", "/deals", { name: "Zulu deal" });
  await team.api("POST", "/deals", { name: "Alpha deal" });
  const page = await team.page("/crm/deals?view=list&sort=created");
  await card(page, "Alpha deal").waitFor();
  expect(await boardOrder(page)).toEqual(["Alpha deal", "Zulu deal"]);
  await page.getByRole("button", { name: "Name" }).waitFor();
  expect(await page.getByLabel("Show deals as").count()).toBe(0);
  expect(await page.getByRole("grid").count()).toBe(0);
});

test("the Archived filter shows archived deals on the board", async () => {
  const team = await workspace("board-archived");
  const { deal } = await team.api("POST", "/deals", { name: "Shelved deal" });
  await team.api("POST", "/deals", { name: "Live deal" });
  await team.api("POST", "/deals/bulk", { ids: [deal.id], action: { action: "archive" } });
  const page = await team.page("/crm/deals");
  await card(page, "Live deal").waitFor();
  expect(await card(page, "Shelved deal").count()).toBe(0);
  await page.goto(`${page.url()}?archived=only`);
  await card(page, "Shelved deal").waitFor();
});

test("a deal dragged onto another stage moves there, and a stage's Add deal starts in it", async () => {
  const team = await workspace("board-drag");
  const { stages } = await team.api("GET", "/stages");
  const [lead, next] = stages as { id: string; name: string }[];
  const { deal } = await team.api("POST", "/deals", { name: "Moving deal", stageId: lead!.id });
  const page = await team.page("/crm/deals?view=board");
  const from = card(page, "Moving deal");
  await from.waitFor();

  const native = await from
    .getByRole("link")
    .evaluate(
      (link) =>
        !link.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true })),
    );
  expect(native).toBe(true);
  const ownDrag = await page.getByRole("main").evaluate((main) => {
    const handle = Object.assign(document.createElement("div"), { draggable: true });
    main.append(handle);
    const event = new DragEvent("dragstart", { bubbles: true, cancelable: true });
    handle.dispatchEvent(event);
    handle.remove();
    return event.defaultPrevented;
  });
  expect(ownDrag).toBe(false);

  const to = page.getByRole("region", { name: next!.name, exact: true });
  const start = (await from.boundingBox())!;
  const end = (await to.boundingBox())!;
  await page.mouse.move(start.x + 20, start.y + 20);
  await page.mouse.down();
  await page.mouse.move(start.x + 40, start.y + 30, { steps: 4 });
  await page.mouse.move(end.x + end.width / 2, end.y + 60, { steps: 8 });
  await page.mouse.up();
  await to.getByRole("listitem").filter({ hasText: "Moving deal" }).waitFor();
  await expect
    .poll(() => dealRow(deal.id), { timeout: 10_000 })
    .toMatchObject({ stageId: next!.id });
  expect(page.url()).toContain("/crm/deals?");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/deals-board.png` });

  await to.getByRole("button", { name: "Add deal" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("Added in place");
  await page.getByRole("button", { name: "Create" }).click();
  await page.waitForURL(/\/crm\/deals\/[^?]+$/);
  const [added] = await db
    .select({ stageId: schema.crmDeals.stageId })
    .from(schema.crmDeals)
    .where(eq(schema.crmDeals.name, "Added in place"));
  expect(added?.stageId).toBe(next!.id);
});

test("a won deal is listed under Projects, and its page sits under Projects", async () => {
  const team = await workspace("projects");
  const { stages } = await team.api("GET", "/stages");
  const won = stages.find((stage: { kind: string }) => stage.kind === "won");
  const { deal } = await team.api("POST", "/deals", { name: "Launch site" });
  await team.api("POST", "/deals", { name: "Still talking" });
  await team.api("PATCH", `/deals/${deal.id}`, { stageId: won.id });

  const page = await team.page("/crm/projects");
  await page.getByRole("row", { name: /Launch site/ }).waitFor();
  expect(await names(page)).toEqual(["Launch site"]);
  await page.getByRole("row", { name: /Launch site/ }).click();
  await page.getByRole("link", { name: "Projects" }).first().waitFor();
  expect(new URL(page.url()).pathname).toContain(`/crm/deals/${deal.id}`);
});

test("the sidebar lists the projects and leads, not closed deals, each marked with its client", async () => {
  const team = await workspace("active");
  const { stages } = await team.api("GET", "/stages");
  const stage = (kind: string) => stages.find((one: { kind: string }) => one.kind === kind).id;
  const project = async (client: string, name: string, kind: string) => {
    const { company } = await team.api("POST", "/companies", { name: client });
    const { deal } = await team.api("POST", "/deals", { name, companyId: company.id });
    if (kind !== "open") await team.api("PATCH", `/deals/${deal.id}`, { stageId: stage(kind) });
    return deal.id as string;
  };
  const launch = await project("Globex", "Launch site", "won");
  await project("Initech", "Still talking", "open");
  await project("Umbrella", "Old rebrand", "done");
  await project("Hooli", "Never signed", "lost");

  const page = await team.page("/crm/tasks");
  const row = page.getByRole("link", { name: "Launch site" });
  await row.getByTitle("Globex").waitFor();
  await page.getByRole("link", { name: "Still talking" }).getByTitle("Initech").waitFor();
  expect(await page.getByRole("link", { name: "Old rebrand" }).count()).toBe(0);
  expect(await page.getByRole("link", { name: "Never signed" }).count()).toBe(0);
  expect(await page.getByRole("link", { name: "Lead" }).count()).toBe(0);

  await row.click();
  await expect.poll(() => new URL(page.url()).pathname).toContain(`/crm/deals/${launch}`);
});

test("deleting a company forever from its page removes it once the owner confirms", async () => {
  const team = await workspace("delete");
  const { company } = await team.api("POST", "/companies", { name: "Gone Ltd" });
  const page = await team.page(`/crm/companies/${company.id}`);

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Delete forever" }).click();
  await page.getByRole("button", { name: "Delete company forever" }).click();

  await page.waitForURL(/\/crm\/companies$/);
  const left = await db
    .select({ id: schema.crmCompanies.id })
    .from(schema.crmCompanies)
    .where(eq(schema.crmCompanies.id, company.id));
  expect(left).toEqual([]);
});

test("a person's page lists their deals and makes another address primary", async () => {
  const team = await workspace("person");
  const { person } = await team.api("POST", "/people", {
    name: "Rita",
    address: "rita@gmail.com",
  });
  await team.api("PATCH", `/people/${person.id}`, { addresses: { add: ["rita@work.test"] } });
  await team.api("POST", "/deals", { name: "Rita's retainer", personIds: [person.id] });

  const page = await team.page(`/crm/people/${person.id}`);
  await page
    .getByRole("main")
    .first()
    .getByRole("link", { name: /Rita's retainer/ })
    .waitFor();
  await page.getByRole("button", { name: "rita@work.test actions" }).click();
  await page.getByRole("menuitem", { name: "Make primary" }).click();

  await expect
    .poll(async () => {
      const rows = await db
        .select({ address: schema.crmPersonEmails.address })
        .from(schema.crmPersonEmails)
        .where(eq(schema.crmPersonEmails.personId, person.id));
      const primary = await team.api("GET", `/people/${person.id}`);
      return { count: rows.length, primary: primary.person.addresses[0] };
    })
    .toEqual({ count: 2, primary: { address: "rita@work.test", isPrimary: true } });
});

test("a close date picked from the calendar is saved and shown as text", async () => {
  const team = await workspace("closedate");
  const { deal } = await team.api("POST", "/deals", { name: "Website rebuild" });
  const page = await team.page(`/crm/deals/${deal.id}`);
  await page.getByRole("group", { name: "Close date" }).getByRole("button").click();
  const month = page.getByRole("grid");
  await month.getByRole("button", { name: /\b15\b/ }).click();

  const today = new Date();
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-15`;
  await expect
    .poll(async () => (await dealCloseOn(deal.id)) ?? null, { timeout: 10_000 })
    .toBe(day);
  const shown = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${day}T00:00`));
  await page.getByRole("group", { name: "Close date" }).getByText(shown).waitFor();
  if (SHOTS) {
    await page.getByRole("group", { name: "Close date" }).getByRole("button").click();
    await page.getByRole("grid").waitFor();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/close-date-picker.png` });
  }
});

test("a person opened from a project keeps the project in the crumbs, and its role shows on hover", async () => {
  const team = await workspace("trail");
  const { stages } = await team.api("GET", "/stages");
  const won = stages.find((stage: { kind: string }) => stage.kind === "won");
  const { company } = await team.api("POST", "/companies", { name: "Calpolli" });
  const { person } = await team.api("POST", "/people", {
    name: "Marisol Velazquez",
    address: "marisol@calpolli.test",
    companyId: company.id,
    jobTitle: "Purchaser, Operations Division",
  });
  const { deal } = await team.api("POST", "/deals", {
    name: "Serie Documental",
    companyId: company.id,
    personIds: [person.id],
  });
  await team.api("PATCH", `/deals/${deal.id}`, { stageId: won.id });
  const box = await createMailbox(db, team.orgId, "studio@trail.test");
  await grant(db, team.orgId, box.id, team.memberId);
  await seedMessage(db, box, {
    subject: "Contract for the series",
    fromAddress: "studio@trail.test",
    fromName: "Studio",
    to: ["marisol@calpolli.test"],
    folder: "Sent",
    uid: 1,
    text: "Hi Marisol, here is the contract.",
  });

  const page = await team.page(`/crm/deals/${deal.id}`);
  const timeline = page.getByRole("list", { name: "Timeline" });
  await timeline.getByText("wrote to").waitFor();
  await timeline.getByText("Marisol Velazquez").waitFor();
  const details = page.getByRole("complementary", { name: "Details" });
  const row = details.getByRole("link", { name: "Marisol Velazquez" });
  await row.waitFor();
  expect(await details.getByText("Purchaser, Operations Division").count()).toBe(0);
  const role = page.getByText("Purchaser, Operations Division");
  await expect
    .poll(
      async () => {
        await page.mouse.move(0, 0);
        await row.getByText("Marisol Velazquez").hover();
        return role.waitFor({ timeout: 1500 }).then(
          () => true,
          () => false,
        );
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/project-page.png` });

  const grip = page.getByRole("button", { name: "Resize details" });
  const hitsGripLeftEdge = await grip.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + 2, rect.top + rect.height / 2);
    return hit === element || element.contains(hit);
  });
  expect(hitsGripLeftEdge).toBe(true);

  await row.click();
  await expect.poll(() => new URL(page.url()).pathname).toContain(`/crm/people/${person.id}`);
  const crumbs = page.getByRole("list", { name: "Record" });
  await crumbs.getByRole("link", { name: "Serie Documental" }).waitFor();
  await crumbs.getByRole("link", { name: "Projects" }).waitFor();
  expect(await crumbs.getByRole("link", { name: "People" }).count()).toBe(0);
  await page.getByRole("heading", { name: "Marisol Velazquez" }).waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/person-from-project.png` });

  await crumbs.getByRole("link", { name: "Serie Documental" }).click();
  await expect.poll(() => new URL(page.url()).pathname).toContain(`/crm/deals/${deal.id}`);
  expect(new URL(page.url()).searchParams.get("via")).toBeNull();
});

test("a project's icon is uploaded from its header, and a person's menu opens mail to them", async () => {
  const team = await workspace("icon");
  const { company } = await team.api("POST", "/companies", { name: "Calpolli" });
  const { person } = await team.api("POST", "/people", {
    name: "Marisol Velazquez",
    address: "marisol@calpolli.test",
    companyId: company.id,
  });
  const { deal } = await team.api("POST", "/deals", {
    name: "Serie Documental",
    companyId: company.id,
    personIds: [person.id],
  });
  const box = await createMailbox(db, team.orgId, "studio@icon.test");
  await grant(db, team.orgId, box.id, team.memberId);

  const page = await team.page(`/crm/deals/${deal.id}`);
  await page.getByRole("button", { name: "Project icon" }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Upload image" }).click();
  await (await chooser).setFiles({ name: "icon.png", mimeType: "image/png", buffer: PNG });
  const header = page.getByRole("button", { name: "Project icon" });
  await expect
    .poll(
      async () =>
        (await header
          .locator("img")
          .getAttribute("src")
          .catch(() => null)) ?? "",
      {
        timeout: 10_000,
      },
    )
    .toContain(`/api/crm/deals/${deal.id}/icon/`);
  expect(await header.locator("img").getAttribute("src")).toContain(`workspace=${team.orgId}`);

  const signed = await page.request.put(
    new URL(`/api/mailboxes/${box.id}/signature?scope=mine`, String(worker.url)).toString(),
    {
      headers: { origin: String(worker.url) },
      data: { bodyText: "Ana, Studio Icon" },
    },
  );
  expect(signed.ok()).toBe(true);
  await page.getByRole("button", { name: "Marisol Velazquez actions" }).click();
  await page.getByRole("menuitem", { name: "Email" }).click();
  await page.getByRole("button", { name: "Send" }).waitFor();
  await page.getByText("marisol@calpolli.test", { exact: true }).waitFor();
  await expect
    .poll(() => page.getByRole("dialog").getByRole("textbox").last().inputValue())
    .toContain("Ana, Studio Icon");
  if (SHOTS) {
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/project-email.png` });
  }
});

async function dealCloseOn(id: string) {
  const [row] = await db
    .select({ closeOn: schema.crmDeals.expectedCloseOn })
    .from(schema.crmDeals)
    .where(eq(schema.crmDeals.id, id));
  return row?.closeOn;
}

async function dealRow(id: string) {
  const [row] = await db
    .select({
      valueMinor: schema.crmDeals.valueMinor,
      valueCurrency: schema.crmDeals.valueCurrency,
      stageId: schema.crmDeals.stageId,
      companyId: schema.crmDeals.companyId,
    })
    .from(schema.crmDeals)
    .where(eq(schema.crmDeals.id, id));
  return row;
}

async function names(page: Page) {
  const rows = page.getByRole("rowgroup").last().getByRole("rowheader");
  return (await rows.allInnerTexts()).map((text) => text.trim().split("\n").at(-1)?.trim());
}

async function pick(page: Page, name: string) {
  await page
    .getByRole("row", { name: new RegExp(name) })
    .getByRole("checkbox")
    .click({ force: true });
}

async function workspace(slug: string) {
  const org = await createOrg(db, slug);
  const email = `owner-${slug}-${Date.now()}@crm.test`;
  const member = await createMember(db, org.id, email);
  await db.update(schema.members).set({ role: "owner" }).where(eq(schema.members.id, member.id));
  await db.insert(schema.orgSetup).values({ orgId: org.id, step: "complete" });
  const origin = String(worker.url);
  const cookie = await signIn({ url: new URL(origin) }, db, email);
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(new URL(`/api/crm${path}`, origin), {
      method,
      headers: { cookie, origin, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
    // oxlint-disable-next-line typescript/no-explicit-any -- test reads of JSON answers
    return (text ? JSON.parse(text) : null) as any;
  };
  return {
    orgId: org.id,
    memberId: member.id,
    api,
    async page(path: string) {
      const context = await browser.newContext({ locale: "en-US" });
      contexts.push(context);
      await context.addCookies(
        cookie.split("; ").map((pair) => {
          const at = pair.indexOf("=");
          return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
        }),
      );
      const page = await context.newPage();
      await page.goto(new URL(`/${org.slug}${path}`, origin).toString());
      return page;
    },
  };
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function resetFilters(page: Page) {
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByRole("button", { name: "Reset" }).click();
}

function card(page: Page, name: string) {
  return page
    .getByRole("list", { name: /^Deals in / })
    .getByRole("listitem")
    .filter({ has: page.getByText(name, { exact: true }) });
}

async function boardOrder(page: Page) {
  const cards = page
    .getByRole("list", { name: /^Deals in / })
    .first()
    .getByRole("listitem");
  const lines = (text: string) => text.split("\n").map((line) => line.trim());
  return (await cards.allInnerTexts()).map((text) => lines(text).find((line) => line.length > 1));
}
