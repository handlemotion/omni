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
  await expect.poll(() => value.inputValue()).toBe("$12,500");
});

test("sorting the deals list by value persists in the URL and the order", async () => {
  const team = await workspace("sort");
  for (const [name, value] of [
    ["Small", 100],
    ["Large", 900],
    ["Medium", 500],
  ] as const) {
    await team.api("POST", "/deals", { name, valueMinor: value * 100, currency: "USD" });
  }
  const page = await team.page("/crm/deals?view=list");
  await page.getByRole("row", { name: /Small/ }).waitFor();
  expect(await names(page)).toEqual(["Large", "Medium", "Small"]);

  await page.getByRole("columnheader", { name: "Value" }).click();

  await expect.poll(() => new URL(page.url()).searchParams.get("sort")).toBe("value");
  expect(new URL(page.url()).searchParams.get("dir")).toBe("desc");
  await expect.poll(() => names(page)).toEqual(["Large", "Medium", "Small"]);
  await page.getByRole("button", { name: "Descending" }).click();
  await expect.poll(() => names(page)).toEqual(["Small", "Medium", "Large"]);
  await page.reload();
  await page.getByRole("row", { name: /Small/ }).waitFor();
  expect(await names(page)).toEqual(["Small", "Medium", "Large"]);
  expect(new URL(page.url()).searchParams.get("dir")).toBe("asc");
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
  await page.getByRole("menuitem", { name: "Archived" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("archived")).toBe("only");
  await expect.poll(() => names(page)).toEqual(["Acme", "Globex"]);
  await pick(page, "Acme");
  await page.getByRole("checkbox", { name: "Select All", exact: true }).click({ force: true });
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await page.getByRole("row", { name: /Globex/ }).waitFor({ state: "detached" });

  await page.getByRole("button", { name: "Remove Archived filter" }).click();
  await expect.poll(() => names(page)).toEqual(["Acme", "Globex", "Initech"]);
});

test("a selection is dropped when a filter changes the view, and stays gone when the filter is removed", async () => {
  const team = await workspace("bulk-view");
  for (const name of ["Acme", "Globex"]) await team.api("POST", "/companies", { name });
  const page = await team.page("/crm/companies");
  await pick(page, "Acme");
  await page.getByText("1 selected").waitFor();

  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByRole("menuitem", { name: "Archived" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("archived")).toBe("only");
  await page.getByRole("button", { name: "Remove Archived filter" }).click();
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
  await page.getByRole("menuitem", { name: "Company" }).click();
  await page.getByRole("menuitem", { name: "None" }).click();

  await expect.poll(() => new URL(page.url()).searchParams.get("company")).toBe("without");
  await expect.poll(() => names(page)).toEqual(["Gail"]);
  await page.reload();
  await page.getByRole("row", { name: /Gail/ }).waitFor();
  expect(await names(page)).toEqual(["Gail"]);

  await page.getByRole("button", { name: "Remove Company filter" }).click();
  await expect.poll(() => names(page)).toEqual(["Gail", "Ivo"]);
});

test("the deal board shows only the owner's deals when filtered by owner", async () => {
  const team = await workspace("board");
  const bea = await createMember(db, team.orgId, `bea-${Date.now()}@crm.test`);
  await team.api("POST", "/deals", { name: "Ana's deal" });
  await team.api("POST", "/deals", { name: "Bea's deal", ownerMemberId: bea.id });

  const page = await team.page(`/crm/deals?owner=${bea.id}`);
  await page.getByRole("row", { name: "Bea's deal" }).waitFor();
  expect(await page.getByRole("row", { name: "Ana's deal" }).count()).toBe(0);
  await page.getByRole("button", { name: "Remove Owner filter" }).click();
  await page.getByRole("row", { name: "Ana's deal" }).waitFor();
});

test("a sort named without a direction starts in its own, and the board falls back to name order", async () => {
  const team = await workspace("board-sort");
  await team.api("POST", "/deals", { name: "Alpha deal" });
  await team.api("POST", "/deals", { name: "Zulu deal" });
  const page = await team.page("/crm/deals?view=list&sort=created");
  await page.getByRole("row", { name: /Alpha deal/ }).waitFor();
  expect(await names(page)).toEqual(["Zulu deal", "Alpha deal"]);

  await page.goto(page.url().replace("view=list", "view=board"));
  await page.getByRole("row", { name: "Alpha deal" }).waitFor();

  const board = page.getByRole("row", { name: /^(Alpha|Zulu) deal$/ });
  const order = (await board.allInnerTexts()).map((text) =>
    text.includes("Alpha") ? "Alpha" : "Zulu",
  );
  expect(order).toEqual(["Alpha", "Zulu"]);
  await page.getByRole("button", { name: "Name" }).waitFor();
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

async function dealRow(id: string) {
  const [row] = await db
    .select({
      valueMinor: schema.crmDeals.valueMinor,
      valueCurrency: schema.crmDeals.valueCurrency,
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
