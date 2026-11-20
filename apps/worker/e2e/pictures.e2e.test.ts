import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
  signIn,
  startMailServiceEndpoint,
  startWorker,
  SYSTEM_MAIL_FROM,
} from "./support.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorker>>;

beforeAll(async () => {
  database = await createTestDatabase();
  mailService = await startMailServiceEndpoint();
  worker = await startWorker({ databaseUrl: database.url, mailServiceUrl: mailService.url });
  const system = await createOrg(database.db, "system");
  await createMailbox(database.db, system.id, SYSTEM_MAIL_FROM);
});

afterAll(async () => {
  await worker?.server.close();
  await mailService?.close();
  await database?.teardown();
});

function send(path: string, cookie: string, init: RequestInit = {}) {
  return fetch(new URL(path, worker.url), { ...init, headers: { cookie, ...init.headers } });
}

function upload(path: string, cookie: string, bytes: Buffer, type: string, name = "picture") {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(bytes)], { type }), name);
  return send(path, cookie, { method: "PUT", body: form });
}

async function userImage(userId: string) {
  const [row] = await database.db
    .select({ image: schema.users.image })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return row!.image;
}

async function orgLogo(orgId: string) {
  const [row] = await database.db
    .select({ logo: schema.organizations.logo })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  return row!.logo;
}

async function person(slug: string, name: string, role = "member") {
  const org = await createOrg(database.db, slug);
  const member = await createMember(database.db, org.id, `${name}@${slug}.test`);
  await database.db.update(schema.members).set({ role }).where(eq(schema.members.id, member.id));
  return { org, member, cookie: await signIn(worker, database.db, `${name}@${slug}.test`) };
}

describe("profile pictures", () => {
  test("upload sets your picture, its URL serves those bytes, and replace and remove clean up", async () => {
    const ana = await person("pics", "ana");

    const first = await upload("/api/account/picture", ana.cookie, PNG, "image/png");
    expect(first.status).toBe(200);
    const { image } = (await first.json()) as { image: string };
    expect(await userImage(ana.member.userId)).toBe(image);

    const served = await send(image, ana.cookie);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("cache-control")).toContain("immutable");
    expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await fetch(new URL(image, worker.url))).status).toBe(401);

    const second = await upload("/api/account/picture", ana.cookie, GIF, "image/gif");
    const replaced = ((await second.json()) as { image: string }).image;
    expect(replaced).not.toBe(image);
    expect((await send(replaced, ana.cookie)).headers.get("content-type")).toBe("image/gif");
    expect((await send(image, ana.cookie)).status).toBe(404);

    const removed = await send("/api/account/picture", ana.cookie, { method: "DELETE" });
    expect(await removed.json()).toEqual({ image: null });
    expect(await userImage(ana.member.userId)).toBeNull();
    expect((await send(replaced, ana.cookie)).status).toBe(404);
    expect((await send("/api/account/picture", ana.cookie, { method: "DELETE" })).status).toBe(200);
  });

  test("refuses a non-image whatever type it claims, an SVG, and anything over 2 MB", async () => {
    const bea = await person("refuse", "bea");
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);

    expect((await upload("/api/account/picture", bea.cookie, html, "image/png")).status).toBe(415);
    expect((await upload("/api/account/picture", bea.cookie, svg, "image/svg+xml")).status).toBe(
      415,
    );
    expect((await upload("/api/account/picture", bea.cookie, big, "image/png")).status).toBe(413);
    expect(await userImage(bea.member.userId)).toBeNull();
  });

  test("removing your picture never deletes another person's", async () => {
    const ana = await person("owner-only", "ana");
    const eve = await person("owner-only-eve", "eve");
    const uploaded = await upload("/api/account/picture", ana.cookie, PNG, "image/png");
    const { image } = (await uploaded.json()) as { image: string };
    await database.db
      .update(schema.users)
      .set({ image })
      .where(eq(schema.users.id, eve.member.userId));

    expect((await send("/api/account/picture", eve.cookie, { method: "DELETE" })).status).toBe(200);
    expect(await userImage(eve.member.userId)).toBeNull();
    expect((await send(image, ana.cookie)).status).toBe(200);
  });
});

describe("workspace logos", () => {
  test("only an owner or admin changes the logo; the switcher shows it; remove clears it", async () => {
    const admin = await person("logo", "ada", "admin");
    await createMember(database.db, admin.org.id, "pat@logo.test");
    const plainCookie = await signIn(worker, database.db, "pat@logo.test");

    const refused = await upload("/api/workspace/logo", plainCookie, PNG, "image/png");
    expect(refused.status).toBe(403);
    expect(await orgLogo(admin.org.id)).toBeNull();

    const set = await upload("/api/workspace/logo", admin.cookie, PNG, "image/png");
    expect(set.status).toBe(200);
    const { logo } = (await set.json()) as { logo: string };
    expect(await orgLogo(admin.org.id)).toBe(logo);

    const listed = (await (await send("/api/workspaces", plainCookie)).json()) as {
      workspaces: { id: string; logo: string | null }[];
    };
    expect(listed.workspaces.find((w) => w.id === admin.org.id)?.logo).toBe(logo);
    const served = await send(logo, plainCookie);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);

    const plainRemove = await send("/api/workspace/logo", plainCookie, { method: "DELETE" });
    expect(plainRemove.status).toBe(403);
    expect(await orgLogo(admin.org.id)).toBe(logo);

    const removed = await send("/api/workspace/logo", admin.cookie, { method: "DELETE" });
    expect(await removed.json()).toEqual({ logo: null });
    expect(await orgLogo(admin.org.id)).toBeNull();
    expect((await send(logo, admin.cookie)).status).toBe(404);
  });
});

describe("project icons", () => {
  test("a deal's picture is served only to its workspace, and replacing or removing it drops the old one", async () => {
    const ana = await person("icons", "ana");
    const eve = await person("icons-eve", "eve");
    const made = await send("/api/crm/deals", ana.cookie, {
      method: "POST",
      headers: { "content-type": "application/json", origin: String(worker.url) },
      body: JSON.stringify({ name: "Serie Documental" }),
    });
    expect(made.status).toBe(201);
    const { deal } = (await made.json()) as { deal: { id: string; iconUrl: string | null } };
    expect(deal.iconUrl).toBeNull();
    const path = `/api/crm/deals/${deal.id}/icon`;

    const first = await upload(path, ana.cookie, PNG, "image/png");
    expect(first.status).toBe(200);
    const icon = ((await first.json()) as { deal: { iconUrl: string } }).deal.iconUrl;
    expect(icon).toMatch(new RegExp(`^${path}/[0-9a-f-]{36}$`));
    const served = await send(icon, ana.cookie);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await send(icon, eve.cookie)).status).toBe(404);
    expect((await upload(path, eve.cookie, GIF, "image/gif")).status).toBe(404);

    const detail = await send(`/api/crm/deals/${deal.id}`, ana.cookie);
    expect(((await detail.json()) as { deal: { iconUrl: string } }).deal.iconUrl).toBe(icon);

    const second = await upload(path, ana.cookie, GIF, "image/gif");
    const replaced = ((await second.json()) as { deal: { iconUrl: string } }).deal.iconUrl;
    expect(replaced).not.toBe(icon);
    expect((await send(icon, ana.cookie)).status).toBe(404);
    expect((await send(replaced, ana.cookie)).headers.get("content-type")).toBe("image/gif");
    expect((await upload(path, ana.cookie, Buffer.from("<svg/>"), "image/svg+xml")).status).toBe(
      415,
    );

    const again = await upload(path, ana.cookie, GIF, "image/gif");
    const reuploaded = ((await again.json()) as { deal: { iconUrl: string } }).deal.iconUrl;
    expect(reuploaded).not.toBe(replaced);
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        i % 2
          ? upload(path, ana.cookie, GIF, "image/gif")
          : upload(path, ana.cookie, PNG, "image/png"),
      ),
    );
    const settled = await send(`/api/crm/deals/${deal.id}`, ana.cookie);
    const current = ((await settled.json()) as { deal: { iconUrl: string } }).deal.iconUrl;
    expect((await send(current, ana.cookie)).status).toBe(200);

    const removed = await send(path, ana.cookie, {
      method: "DELETE",
      headers: { origin: String(worker.url) },
    });
    expect(((await removed.json()) as { deal: { iconUrl: null } }).deal.iconUrl).toBeNull();
    expect((await send(current, ana.cookie)).status).toBe(404);
  });
});
