import { WORKSPACE_HEADER } from "@omni/client";
import { createOrgWithOwner, schema } from "@omni/db";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createOrg,
  createTestDatabase,
  grant,
  seedMessage,
  signIn,
  startMailServiceEndpoint,
  startWorkerWithNetwork,
  SYSTEM_MAIL_FROM,
  WEB_ORIGIN,
} from "../../worker/e2e/support.ts";
import { lineFit, showsInFull, sidewaysInside, sidewaysOverflow } from "./layout.ts";
import { exportWebApp, openApp, serveWebApp } from "./web-app.ts";

const unbreakableAddress200 = (c: string) =>
  `${c.repeat(64)}@${c.repeat(60)}.${c.repeat(60)}.${c.repeat(8)}.test`;

const LONG = {
  sender:
    "Maximiliana Alejandra de la Santísima Trinidad Fernández-Würtemberg y Montenegro-Castellanos, Head of Global Partnerships",
  address: unbreakableAddress200("a"),
  subject:
    "Re: Fwd: Re: Final final version of the Q3 2026 partnership agreement between Very Long Holdings International and the Consolidated Amalgamated Widget Manufacturers of the Northern Hemisphere, with every redline accepted and the signature pages attached",
  url: `https://docs.example.test/${"shared-drive-folder-".repeat(12)}document?id=${"0123456789abcdef".repeat(6)}`,
  attachments: Array.from(
    { length: 12 },
    (_, n) =>
      `${n + 1}_Q3_2026_partnership_agreement_final_final_v12_signed_by_every_party_and_countersigned.pdf`,
  ),
  company:
    "Consolidated Amalgamated Widget Manufacturers of the Northern Hemisphere and Associated Subsidiaries International Holdings Limited",
  unbreakableDomain: `${Array.from({ length: 12 }, (_, n) => `subsidiarynumber${n + 1}`).join(".")}.example.test`,
  person:
    "Maximiliana Alejandra de la Santísima Trinidad Fernández-Würtemberg y Montenegro-Castellanos",
  personAddress: unbreakableAddress200("c"),
  deal: "Enterprise-wide multi-year renewal and expansion of the global widget supply agreement across every region, subsidiary and business unit",
  folder:
    "Contracts, statements of work, invoices and signed paperwork for every client engagement since 2019 (archived, do not delete)",
  file: `${"Q3_2026_partnership_agreement_final_final_v12_".repeat(4)}signed.pdf`,
};

const TODAYS_TIME = /^\d{1,2}:\d{2}\s?[AP]M$/;

interface Seeded {
  threadId: string;
  plainThreadId: string;
  companyId: string;
  personId: string;
  dealId: string;
  folderId: string;
}

type Clamp = [text: string | RegExp, lines: number];

const SCREENS: {
  name: string;
  path: (s: Seeded) => string;
  shows: string;
  clamped?: Clamp[];
  inFull?: string[];
}[] = [
  {
    name: "Mail inbox",
    path: () => "/mail",
    shows: LONG.sender,
    clamped: [
      [LONG.sender, 1],
      [LONG.address, 1],
      [LONG.subject, 1],
      [TODAYS_TIME, 1],
    ],
  },
  {
    name: "Mail thread",
    path: (s) => `/mail/thread/${s.threadId}`,
    shows: LONG.subject,
    clamped: [...LONG.attachments.map((name) => [name, 1] satisfies Clamp), [TODAYS_TIME, 1]],
    inFull: [LONG.subject],
  },
  { name: "Mail trash, empty", path: () => "/mail?page=trash", shows: "Trash is empty" },
  { name: "Mail compose", path: () => "/mail/compose", shows: "Cc Bcc" },
  {
    name: "Mail reply",
    path: (s) => `/mail/compose?threadId=${s.threadId}`,
    shows: "maximiliana@partners.test",
    clamped: [["maximiliana@partners.test", 1]],
  },
  {
    name: "Mail reply to an unbreakable address",
    path: (s) => `/mail/compose?threadId=${s.plainThreadId}`,
    shows: LONG.address,
    clamped: [[LONG.address, 1]],
  },
  {
    name: "Drive",
    path: () => "/drive",
    shows: LONG.folder,
    clamped: [
      [LONG.folder, 2],
      [LONG.file, 1],
      [TODAYS_TIME, 1],
    ],
  },
  {
    name: "Drive folder",
    path: (s) => `/drive/folder/${s.folderId}?name=${encodeURIComponent(LONG.folder)}`,
    shows: LONG.file,
    clamped: [
      [LONG.folder, 1],
      [LONG.file, 1],
      [TODAYS_TIME, 1],
    ],
  },
  { name: "Drive trash, empty", path: () => "/drive?page=trash", shows: "Trash is empty" },
  {
    name: "CRM companies",
    path: () => "/crm",
    shows: LONG.company,
    clamped: [
      [LONG.company, 2],
      [LONG.unbreakableDomain, 1],
    ],
  },
  {
    name: "CRM people",
    path: () => "/crm?page=people",
    shows: LONG.person,
    clamped: [
      [LONG.person, 2],
      [LONG.personAddress, 1],
    ],
  },
  {
    name: "CRM deals",
    path: () => "/crm?page=deals",
    shows: LONG.deal,
    clamped: [[LONG.deal, 2]],
  },
  {
    name: "CRM company",
    path: (s) => `/crm/company/${s.companyId}`,
    shows: LONG.company,
    clamped: [
      [LONG.person, 2],
      [LONG.deal, 2],
    ],
    inFull: [LONG.company, LONG.unbreakableDomain],
  },
  {
    name: "CRM person",
    path: (s) => `/crm/person/${s.personId}`,
    shows: LONG.personAddress,
    clamped: [[LONG.deal, 2]],
    inFull: [LONG.person, LONG.personAddress],
  },
  { name: "CRM projects, empty", path: () => "/crm?page=projects", shows: "No projects yet" },
  {
    name: "CRM deal",
    path: (s) => `/crm/deal/${s.dealId}`,
    shows: LONG.person,
    clamped: [[LONG.person, 2]],
    inFull: [LONG.deal],
  },
];

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorkerWithNetwork>>;
let app: Awaited<ReturnType<typeof serveWebApp>>;
let browser: Browser;
let context: BrowserContext;
let seeded: Seeded;

beforeAll(async () => {
  app = await serveWebApp();
  const exported = exportWebApp(app.origin);
  database = await createTestDatabase();
  mailService = await startMailServiceEndpoint();
  worker = await startWorkerWithNetwork({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    vars: { BETTER_AUTH_URL: app.origin, AUTH_TRUSTED_ORIGINS: `${WEB_ORIGIN},${app.origin}` },
  });
  app.proxyTo(worker.url);
  const { cookie, workspaceId, ...rest } = await seed();
  seeded = rest;
  await exported;
  browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
  context = await openApp(browser, app, cookie, workspaceId);
}, 300_000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await worker?.close();
  await mailService?.close();
  await app?.close();
  await database?.teardown();
});

async function seed() {
  const { db } = database;
  const system = await createOrg(db, "system");
  await createMailbox(db, system.id, SYSTEM_MAIL_FROM);
  const email = "ana@worst.test";
  const acme = await createOrgWithOwner(db, {
    name: "Acme",
    slug: "worst-acme",
    ownerEmail: email,
  });
  const box = await createMailbox(db, acme.orgId, email, "personal");
  await grant(db, acme.orgId, box.id, acme.memberId);
  const long = await seedMessage(db, box, {
    subject: LONG.subject,
    fromAddress: "maximiliana@partners.test",
    fromName: LONG.sender,
    uid: 1,
    sentAt: new Date(),
    text: `Please sign here: ${LONG.url} and send the copies to ${LONG.address} before Friday.`,
  });
  await db.insert(schema.attachments).values(
    LONG.attachments.map((filename, n) => ({
      orgId: acme.orgId,
      messageId: long.messageId,
      filename,
      mimeType: "application/pdf",
      size: 1024 * (n + 1),
      r2Key: `${acme.orgId}/${box.id}/att/${n}`,
    })),
  );
  const plain = await seedMessage(db, box, {
    subject: "No name, no spaces",
    fromAddress: LONG.address,
    uid: 2,
    sentAt: new Date(Date.now() - 1000),
    text: LONG.url,
  });

  const cookie = await signIn(worker, db, email);
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(new URL(`/api${path}`, worker.url), {
      method,
      headers: {
        cookie,
        origin: app.origin,
        [WORKSPACE_HEADER]: acme.orgId,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok)
      throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    // oxlint-disable-next-line typescript/no-explicit-any -- seeding reads of JSON answers
    return (await response.json()) as any;
  };

  const company = (
    await call("POST", "/crm/companies", { name: LONG.company, domains: [LONG.unbreakableDomain] })
  ).company;
  const person = (
    await call("POST", "/crm/people", {
      name: LONG.person,
      address: LONG.personAddress,
      companyId: company.id,
    })
  ).person;
  const deal = (
    await call("POST", "/crm/deals", {
      name: LONG.deal,
      companyId: company.id,
      personIds: [person.id],
      valueMinor: 999_999_999_999,
      currency: "USD",
    })
  ).deal;

  const folder = (await call("POST", "/storage/folders", { name: LONG.folder, space: "personal" }))
    .node;
  const upload = async (place: object) => {
    const bytes = new TextEncoder().encode("worst case");
    const { upload: opened } = await call("POST", "/storage/uploads", {
      name: LONG.file,
      size: bytes.length,
      mimeType: "application/pdf",
      ...place,
    });
    const part = await fetch(new URL(`/api/storage/uploads/${opened.id}/parts/1`, worker.url), {
      method: "PUT",
      headers: {
        cookie,
        [WORKSPACE_HEADER]: acme.orgId,
        "content-type": "application/octet-stream",
      },
      body: bytes,
    });
    if (!part.ok) throw new Error(`upload part: ${part.status}`);
    await call("POST", `/storage/uploads/${opened.id}/complete`);
  };
  await upload({ space: "personal" });
  await upload({ parentId: folder.id });

  return {
    cookie,
    workspaceId: acme.orgId,
    threadId: long.threadId,
    plainThreadId: plain.threadId,
    companyId: company.id as string,
    personId: person.id as string,
    dealId: deal.id as string,
    folderId: folder.id as string,
  };
}

async function open(path: string, shows: string) {
  const page = await context.newPage();
  await page.goto(new URL(path, app.origin).toString());
  await page.getByText(shows, { exact: true }).first().waitFor({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  return page satisfies Page;
}

test.for(SCREENS)("$name: nothing runs past the screen's sides", async (screen) => {
  const page = await open(screen.path(seeded), screen.shows);
  try {
    const layout = await page.evaluate(sidewaysOverflow, 0.5);
    expect(
      layout.offenders,
      `${screen.name}: elements past the viewport (${layout.viewport}px)`,
    ).toEqual([]);
    expect(layout.scrollWidth, `${screen.name}: document scrolls sideways`).toBeLessThanOrEqual(
      layout.viewport,
    );
  } finally {
    await page.close();
  }
});

test.for(SCREENS.filter((screen) => screen.clamped))(
  "$name: row text stays within its lines and ends in an ellipsis when cut",
  async (screen) => {
    const page = await open(screen.path(seeded), screen.shows);
    try {
      const problems: unknown[] = [];
      for (const [text, lines] of screen.clamped ?? []) {
        const found = page.getByText(text, { exact: true });
        const label = String(text).slice(0, 40);
        if (!(await found.count())) problems.push({ text: label, found: 0 });
        for (const element of await found.all()) {
          const fit = await element.evaluate(lineFit);
          const cut = fit.spills || fit.hiddenBelow;
          if (fit.lines > lines || (cut && !fit.ellipsis))
            problems.push({
              text: label,
              allowed: lines,
              shown: await element.textContent(),
              ...fit,
            });
        }
      }
      expect(
        problems,
        `${screen.name}: text that runs over its lines or is cut without an ellipsis`,
      ).toEqual([]);
    } finally {
      await page.close();
    }
  },
);

test("the inbox row with the longest sender keeps its time inside the row", async () => {
  const page = await open("/mail", LONG.sender);
  try {
    const row = page
      .getByRole("link")
      .or(page.getByRole("button"))
      .filter({ hasText: LONG.sender });
    const time = row.getByText(TODAYS_TIME);
    await time.waitFor();
    const fit = await time.evaluate(sidewaysInside, await row.elementHandle());
    expect(fit, "the time is pushed out of the row").toMatchObject({ inside: true });
  } finally {
    await page.close();
  }
});

test("the menu fits the screen, and closing it lands on the module it shows", async () => {
  const page = await open("/mail", LONG.sender);
  try {
    await page.getByRole("button", { name: "Open menu" }).click();
    await page.getByText("Folders", { exact: true }).waitFor();
    const layout = await page.evaluate(sidewaysOverflow, 0.5);
    expect(layout.offenders, "menu elements past the viewport").toEqual([]);
    await page.getByRole("button", { name: "Drive", exact: true }).click();
    await page.getByRole("button", { name: "Close menu" }).click();
    await page.getByText(LONG.folder, { exact: true }).first().waitFor({ timeout: 30_000 });
  } finally {
    await page.close();
  }
});

test.for(SCREENS.filter((screen) => screen.inFull))(
  "$name: names and subjects show in full, wrapped",
  async (screen) => {
    const page = await open(screen.path(seeded), screen.shows);
    try {
      for (const text of screen.inFull ?? []) {
        const element = page.getByText(text, { exact: true }).first();
        const shown = await element.evaluate(showsInFull);
        expect(shown.text).toBe(text);
        expect(shown.scrollHeight, `lines hidden below "${text.slice(0, 40)}"`).toBeLessThanOrEqual(
          shown.clientHeight + 1,
        );
        expect(shown.scrollWidth, `"${text.slice(0, 40)}" is cut at its side`).toBeLessThanOrEqual(
          shown.clientWidth + 1,
        );
      }
    } finally {
      await page.close();
    }
  },
);

test.for(SCREENS.filter((screen) => screen.name.endsWith("empty")))(
  "$name: an empty list says so",
  async (screen) => {
    const page = await open(screen.path(seeded), screen.shows);
    try {
      await expect.poll(() => page.getByText(screen.shows, { exact: true }).isVisible()).toBe(true);
    } finally {
      await page.close();
    }
  },
);
