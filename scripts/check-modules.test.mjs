import assert from "node:assert/strict";
import { test } from "node:test";
import { check, findProblems } from "./check-modules.mjs";

const MODULES = {
  mail: { uses: [], workerUses: ["storage"], prefixed: false },
  storage: { uses: [], prefixed: true },
  crm: { uses: ["mail", "storage"], prefixed: true },
};

const SCHEMA = {
  "packages/db/src/schema/mail.ts": `export const threads = pgTable("threads", {});`,
  "packages/db/src/schema/storage.ts": `export const storageNodes = pgTable("storage_nodes", {});`,
  "packages/db/src/schema/crm.ts": `export const crmPeople = pgTable("crm_people", {});`,
};

const problemsIn = (files) =>
  findProblems(new Map(Object.entries({ ...SCHEMA, ...files })), MODULES).map(
    (p) => `${p.file} ${p.rule}`,
  );

test("a platform file that imports a module's private folder fails", () => {
  const problems = problemsIn({
    "packages/db/src/billing.ts": `import { storageUsageOf } from "./storage/maintenance.ts";`,
  });
  assert.deepEqual(problems, ["packages/db/src/billing.ts private"]);
});

test("a route that selects from a module's table through `schema` fails", () => {
  const problems = problemsIn({
    "apps/worker/src/routes/files.ts": `import { schema } from "@omni/db";\ndb.select().from(schema.storageNodes);`,
  });
  assert.deepEqual(problems, ["apps/worker/src/routes/files.ts tables"]);
});

test("a table imported by name from the schema barrel fails, a same-named local does not", () => {
  const problems = problemsIn({
    "packages/db/src/sweep.ts": `import { members, storageNodes as nodes } from "./schema/index.ts";`,
    "apps/worker/src/routes/uploads.ts": `import { storageNodes } from "./storage-uploads.ts";`,
  });
  assert.deepEqual(problems, ["packages/db/src/sweep.ts tables"]);
});

test("Storage and Mail know nothing of each other, not even through a surface", () => {
  const problems = problemsIn({
    "packages/db/src/storage/sharing.ts": `import { grantFor } from "../mail.ts";`,
    "packages/db/src/mail/member-mail.ts": `import { storageOf } from "../storage.ts";`,
  });
  assert.deepEqual(problems, [
    "packages/db/src/storage/sharing.ts uses",
    "packages/db/src/mail/member-mail.ts uses",
  ]);
});

test("CRM may use Storage's surface, never its folder or its tables", () => {
  const problems = problemsIn({
    "packages/db/src/crm/folders.ts": [
      `import { createFolder } from "../storage.ts";`,
      `import { lockNode } from "../storage/tree.ts";`,
      `import { storageNodes } from "../schema/storage.ts";`,
    ].join("\n"),
  });
  assert.deepEqual(problems, [
    "packages/db/src/crm/folders.ts private",
    "packages/db/src/crm/folders.ts tables",
  ]);
});

test("the mail service is Mail's own and may name its tables; platform code may not", () => {
  const problems = problemsIn({
    "apps/mail/src/pg-store.ts": `import { schema } from "@omni/db";
schema.threads;`,
    "packages/db/src/workspaces.ts": `import { threads } from "./schema/index.ts";`,
  });
  assert.deepEqual(problems, ["packages/db/src/workspaces.ts tables"]);
});

test("a schema file may name another module's table in a foreign key", () => {
  const problems = problemsIn({
    "packages/db/src/schema/crm.ts": `${SCHEMA["packages/db/src/schema/crm.ts"]}\nimport { storageNodes } from "./storage.ts";`,
  });
  assert.deepEqual(problems, []);
});

test("a Worker module folder is reached only by its module and the registrars", () => {
  const problems = problemsIn({
    "apps/worker/src/app.ts": `import { crm } from "./crm/routes.ts";`,
    "apps/worker/src/routes/mail.ts": `import { crmLookup } from "../crm/lookup.ts";`,
    "apps/worker/src/storage/routes.ts": `import { crmLookup } from "../crm/lookup.ts";`,
  });
  assert.deepEqual(problems, [
    "apps/worker/src/routes/mail.ts worker",
    "apps/worker/src/storage/routes.ts uses",
  ]);
});

test("Mail's Worker folder may call Storage for save to drive; Mail in @omni/db still may not", () => {
  const files = {
    "packages/db/src/index.ts": `export * from "./storage.ts";`,
    "packages/db/src/storage.ts": `export function memberStorage() {}`,
    "apps/worker/src/mail/save-to-drive.ts": [
      `import { memberStorage } from "@omni/db";`,
      `import { storageLimit } from "../storage/core.ts";`,
    ].join("\n"),
    "packages/db/src/mail/member-mail.ts": `import { memberStorage } from "../storage.ts";`,
    "apps/mail/src/sync.ts": `import { storageLimit } from "../../worker/src/storage/core.ts";`,
  };
  assert.deepEqual(problemsIn(files), [
    "packages/db/src/mail/member-mail.ts uses",
    "apps/mail/src/sync.ts uses",
  ]);
});

test("a dynamic import is checked like a static one", () => {
  const problems = problemsIn({
    "apps/worker/src/queue.ts": `const { tree } = await import("../../../packages/db/src/storage/tree.ts");`,
  });
  assert.deepEqual(problems, ["apps/worker/src/queue.ts private"]);
});

test("a new module's table must carry its prefix", () => {
  const problems = problemsIn({
    "packages/db/src/schema/crm.ts": `export const deals = pgTable("deals", {});`,
  });
  assert.deepEqual(problems, ["packages/db/src/schema/crm.ts naming"]);
});

test("debt hides its own problem and is reported once it no longer fails", () => {
  const files = new Map(
    Object.entries({
      ...SCHEMA,
      "packages/db/src/sweep.ts": `import { storageNodes } from "./schema/storage.ts";`,
    }),
  );
  const debt = [
    { file: "packages/db/src/sweep.ts", rule: "tables" },
    { file: "packages/db/src/gone.ts", rule: "tables" },
  ];
  const { problems, stale } = check(files, MODULES, debt);
  assert.deepEqual(problems, []);
  assert.deepEqual(stale, [{ file: "packages/db/src/gone.ts", rule: "tables" }]);
});

test("a module cannot reach another undeclared module through the @omni/db barrel", () => {
  const files = {
    "packages/db/src/index.ts": `export * from "./storage.ts";\nexport * from "./mail.ts";\nexport * as schema from "./schema/index.ts";`,
    "packages/db/src/storage.ts": `export { readTree } from "./storage/tree.ts";`,
    "packages/db/src/storage/tree.ts": `export function readTree() {}`,
    "packages/db/src/mail.ts": `export * from "./mail/member-mail.ts";`,
    "packages/db/src/mail/member-mail.ts": `export async function grantFor() {}`,
    "packages/db/src/storage/lookup.ts": `import { grantFor, schema } from "../index.ts";`,
    "apps/worker/src/crm/files.ts": `import { readTree, grantFor } from "@omni/db";`,
  };
  assert.deepEqual(problemsIn(files), ["packages/db/src/storage/lookup.ts uses"]);
});

test("a table read through any name the schema is bound to fails", () => {
  const problems = problemsIn({
    "packages/db/src/crm/lookup.ts": `import { schema as s } from "../index.ts";\ndb.select().from(s.storageNodes);`,
    "apps/worker/src/crm/routes.ts": `import * as tables from "@omni/db/schema";\ntables.storageNodes;`,
    "apps/worker/src/routes/mail.ts": `const s = { storageNodes: 1 };\ns.storageNodes;`,
  });
  assert.deepEqual(problems, [
    "packages/db/src/crm/lookup.ts tables",
    "apps/worker/src/crm/routes.ts tables",
  ]);
});

test("a module's tables split into a schema folder are still its own", () => {
  const problems = problemsIn({
    "packages/db/src/schema/mail/helpdesk.ts": `export const tags = pgTable("tags", {});`,
    "packages/db/src/crm/tags.ts": `import { tags } from "../schema/mail/helpdesk.ts";`,
  });
  assert.deepEqual(problems, ["packages/db/src/crm/tags.ts tables"]);
});

test("a namespace or dynamic import of the barrel is traced like a named one", () => {
  const files = {
    "packages/db/src/index.ts": `export * from "./mail.ts";\nexport * as schema from "./schema/index.ts";`,
    "packages/db/src/mail.ts": `export * from "./mail/customers.ts";`,
    "packages/db/src/mail/customers.ts": `export async function recordCustomer() {}`,
    "apps/worker/src/storage/a.ts": `import * as db from "@omni/db";\ndb.recordCustomer();`,
    "apps/worker/src/storage/b.ts": `const { recordCustomer } = await import("@omni/db");`,
    "apps/worker/src/storage/c.ts": `const db = await import("@omni/db");\ndb.recordCustomer();`,
  };
  assert.deepEqual(problemsIn(files), [
    "apps/worker/src/storage/a.ts uses",
    "apps/worker/src/storage/b.ts uses",
    "apps/worker/src/storage/c.ts uses",
  ]);
});

test("a table read through the barrel's schema under a namespace fails", () => {
  const problems = problemsIn({
    "packages/db/src/mail/files.ts": `import * as db from "../index.ts";\ndb.schema.storageNodes;`,
  });
  assert.deepEqual(problems, ["packages/db/src/mail/files.ts tables"]);
});

test("a file re-exported twice by a surface keeps every name it exports", () => {
  const files = {
    "packages/db/src/index.ts": `export * from "./mail.ts";`,
    "packages/db/src/mail.ts": `export type { InboxAuditAction } from "./mail/inbox-admin.ts";\nexport * from "./mail/inbox-admin.ts";`,
    "packages/db/src/mail/inbox-admin.ts": `export type InboxAuditAction = string;\nexport async function recordInboxEvent() {}`,
    "apps/worker/src/storage/audit.ts": `import { recordInboxEvent } from "@omni/db";`,
  };
  assert.deepEqual(problemsIn(files), ["apps/worker/src/storage/audit.ts uses"]);
});

test("a module that re-exports a whole barrel is checked against everything it hands on", () => {
  const files = {
    "packages/db/src/index.ts": `export * from "./mail.ts";`,
    "packages/db/src/mail.ts": `export * from "./mail/customers.ts";`,
    "packages/db/src/mail/customers.ts": `export async function recordCustomer() {}`,
    "apps/worker/src/storage/probe.ts": `export * from "@omni/db";`,
    "apps/worker/src/crm/probe.ts": `export * from "@omni/db";`,
  };
  assert.deepEqual(problemsIn(files), ["apps/worker/src/storage/probe.ts uses"]);
});
