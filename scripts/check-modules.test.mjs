// Each case is a way code could slip past a module's door and the check stay green.
import assert from "node:assert/strict";
import { test } from "node:test";
import { check, findProblems } from "./check-modules.mjs";

const MODULES = {
  mail: { uses: [], legacy: true, files: ["packages/db/src/member-mail.ts"] },
  storage: { uses: [], legacy: false, files: [] },
  crm: { uses: ["mail", "storage"], legacy: false, files: [] },
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

test("Storage and Mail know nothing of each other, even a mail file not moved yet", () => {
  const problems = problemsIn({
    "packages/db/src/storage/sharing.ts": `import { grantFor } from "../member-mail.ts";`,
    "packages/db/src/member-mail.ts": `import { storageOf } from "./storage.ts";`,
  });
  assert.deepEqual(problems, [
    "packages/db/src/storage/sharing.ts uses",
    "packages/db/src/member-mail.ts uses",
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

test("a module never names a legacy module's tables; platform code still may", () => {
  const problems = problemsIn({
    "packages/db/src/crm/timeline.ts": `import { threads } from "../schema/index.ts";`,
    "packages/db/src/workspaces.ts": `import { threads } from "./schema/index.ts";`,
  });
  assert.deepEqual(problems, ["packages/db/src/crm/timeline.ts tables"]);
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
