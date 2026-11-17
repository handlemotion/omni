import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

/**
 * The modules and what each may use. Mail's tables predate `<module>_*` and keep their names: a
 * rename is a destructive migration that buys nothing (ADR 0035 decision 3). Mail's Worker
 * folder calls Storage's door to save an attachment to drive (ADR 0039 decision 3).
 */
export const MODULES = {
  mail: { uses: [], workerUses: ["storage"], prefixed: false },
  storage: { uses: [], prefixed: true },
  crm: { uses: ["mail", "storage"], prefixed: true },
};

const REGISTRARS = [
  "apps/worker/src/app.ts",
  "apps/worker/src/index.ts",
  "apps/worker/src/modules.ts",
  "apps/worker/src/mcp/",
];

/** Files that broke a rule before it existed: `file` may break `rule`. Only ever shrinks. */
export const DEBT = [
  { file: "packages/db/src/abandoned-sign-ups.ts", rule: "tables" },
  { file: "apps/worker/src/context.ts", rule: "worker" },
  { file: "apps/worker/src/routes/stripe-webhook.ts", rule: "worker" },
];

const SOURCE = /^(packages\/[^/]+\/src|apps\/(worker|mail)\/src)\/.*\.(ts|tsx|mts)$/;
const TEST = /(\.test\.|\/e2e\/)/;

const PACKAGES = {
  "@omni/db": "packages/db/src/index.ts",
  "@omni/db/schema": "packages/db/src/schema/index.ts",
  "@omni/contracts": "packages/contracts/src/index.ts",
};

/** The module a file belongs to, and which part of it, or null for platform code. */
export function ownerOf(file, modules = MODULES) {
  for (const name of Object.keys(modules)) {
    if (file.startsWith(`apps/${name}/src/`)) return { module: name, part: "service" };
    if (file === `packages/db/src/${name}.ts`) return { module: name, part: "surface" };
    if (file.startsWith(`packages/db/src/${name}/`)) return { module: name, part: "private" };
    if (file === `packages/db/src/schema/${name}.ts`) return { module: name, part: "schema" };
    if (file.startsWith(`packages/db/src/schema/${name}/`)) return { module: name, part: "schema" };
    if (file === `packages/contracts/src/${name}.ts`) return { module: name, part: "contract" };
    if (file.startsWith(`apps/worker/src/${name}/`)) return { module: name, part: "worker" };
  }
  return null;
}

/**
 * Every static and dynamic import or re-export in a source: its specifier, the names it takes
 * from that module (`*` for all of it) and the local name each is bound to.
 */
export function importsOf(source) {
  const found = [];
  const STATIC = /\b(import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  for (const [, keyword, , clause, specifier] of source.matchAll(STATIC)) {
    const bindings = bindingsOf(clause);
    const reexportsAll =
      keyword === "export" && bindings.some((b) => b.imported === "*" && !b.local);
    found.push({ specifier, bindings, names: bindings.map((b) => b.imported), reexportsAll });
  }
  for (const [, specifier] of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    found.push({ specifier, bindings: [{ imported: "*", local: null }], names: ["*"] });
  }
  for (const [, specifier] of source.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) {
    found.push({ specifier, bindings: [], names: [] });
  }
  return found;
}

function bindingsOf(clause) {
  const braces = clause.match(/\{([\s\S]*)\}/);
  const bindings = braces
    ? braces[1]
        .split(",")
        .map((part) => part.trim().replace(/^type\s+/, ""))
        .filter(Boolean)
        .map((part) => {
          const [imported, local = imported] = part.split(/\s+as\s+/).map((x) => x.trim());
          return { imported, local };
        })
    : [];
  const outside = clause.replace(/\{[\s\S]*\}/, "");
  const star = outside.match(/\*\s*(?:as\s+(\w+))?/);
  if (star) bindings.push({ imported: "*", local: star[1] ?? null });
  return bindings;
}

/**
 * Where each name a barrel exports is defined: name → file, following `export *`,
 * `export { a as b } from` and `export * as x from` through the files given.
 */
export function exportOrigins(files, entry, done = new Map(), active = new Set()) {
  if (done.has(entry)) return done.get(entry);
  const origins = new Map();
  const source = files.get(entry);
  if (!source || active.has(entry)) return origins;
  active.add(entry);
  const DECLARED =
    /^export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum)\s+(\w+)/gm;
  for (const [, name] of source.matchAll(DECLARED)) origins.set(name, entry);
  const REEXPORT = /\bexport\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  for (const [, clause, specifier] of source.matchAll(REEXPORT)) {
    const target = resolve(entry, specifier);
    if (!target) continue;
    for (const { imported, local } of bindingsOf(clause)) {
      if (imported !== "*") {
        const inner = exportOrigins(files, target, done, active).get(imported);
        origins.set(local, inner ?? target);
      } else if (local) origins.set(local, target);
      else {
        for (const [name, file] of exportOrigins(files, target, done, active))
          origins.set(name, file);
      }
    }
  }
  active.delete(entry);
  done.set(entry, origins);
  return origins;
}

/** The repository path an import specifier points at, or null when it leaves the checked code. */
export function resolve(from, specifier) {
  if (specifier in PACKAGES) return PACKAGES[specifier];
  if (!specifier.startsWith(".")) return null;
  return normalize(join(dirname(from), specifier));
}

/** Each module's tables, from `schema/<module>.ts` and `schema/<module>/`: identifier, SQL name, file. */
export function tablesOf(files, modules = MODULES) {
  const tables = new Map();
  const TABLE = /export\s+const\s+(\w+)\s*=\s*pgTable\(\s*["']([^"']+)["']/g;
  for (const [file, source] of files) {
    const owner = file.startsWith("packages/db/src/schema/") ? ownerOf(file, modules) : null;
    if (owner?.part !== "schema") continue;
    for (const [, identifier, sqlName] of source.matchAll(TABLE)) {
      tables.set(identifier, { module: owner.module, sqlName, file });
    }
  }
  return tables;
}

function tablesNamedBy(file, source, tables) {
  const named = new Set();
  const aliases = new Set(["schema"]);
  for (const { specifier, bindings } of importsOf(source)) {
    const target = resolve(file, specifier);
    for (const { imported, local } of bindings) {
      if (target === "packages/db/src/index.ts" && imported === "schema") aliases.add(local);
      if (target?.startsWith("packages/db/src/schema/") && imported === "*" && local) {
        aliases.add(local);
      }
    }
  }
  for (const { specifier, names } of importsOf(source)) {
    const target = resolve(file, specifier);
    if (!target?.startsWith("packages/db/src/schema/")) continue;
    const all = [...tables].filter(
      ([, t]) => target === t.file || target === `packages/db/src/schema/${t.module}.ts`,
    );
    for (const name of names) {
      if (name === "*") all.forEach(([identifier]) => named.add(identifier));
      else if (tables.has(name)) named.add(name);
    }
  }
  for (const alias of aliases) {
    const access = new RegExp(`(?<![\\w$])${alias}\\.(\\w+)`, "g");
    for (const [, identifier] of source.matchAll(access)) {
      if (tables.has(identifier)) named.add(identifier);
    }
  }
  return [...named];
}

const BARRELS = ["packages/db/src/index.ts", "packages/contracts/src/index.ts"];

function barrelProblems(file, source, owner, origins, modules) {
  if (!owner) return [];
  const foreign = new Set();
  for (const { specifier, bindings, reexportsAll } of importsOf(source)) {
    const barrel = resolve(file, specifier);
    if (!BARRELS.includes(barrel)) continue;
    const names = reexportsAll ? origins(barrel).keys() : namesTaken(source, specifier, bindings);
    for (const name of names) {
      const origin = origins(barrel).get(name);
      const to = origin && ownerOf(origin, modules);
      if (!to || to.module === owner.module || to.part === "schema") continue;
      if (!usesOf(owner, modules).includes(to.module)) foreign.add(`${name} (${to.module})`);
    }
  }
  return foreign.size ? [{ file, rule: "uses", message: MESSAGES.barrel([...foreign]) }] : [];
}

function namesTaken(source, specifier, bindings) {
  const names = new Set();
  const members = (local) => {
    for (const [, name] of source.matchAll(new RegExp(`(?<![\\w$.])${local}\\.(\\w+)`, "g"))) {
      names.add(name);
    }
  };
  for (const { imported, local } of bindings) {
    if (imported !== "*") names.add(imported);
    else if (local) members(local);
  }
  if (!bindings.some((b) => b.imported === "*" && !b.local)) return names;
  const spec = specifier.replaceAll(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const call = `await\\s+import\\(\\s*["']${spec}["']\\s*\\)`;
  for (const [, list] of source.matchAll(new RegExp(`\\{([^}]*)\\}\\s*=\\s*${call}`, "g"))) {
    for (const part of list.split(",")) {
      const name = part.split(":")[0].trim();
      if (name) names.add(name);
    }
  }
  for (const [, local] of source.matchAll(new RegExp(`(\\w+)\\s*=\\s*${call}`, "g")))
    members(local);
  for (const [, name] of source.matchAll(new RegExp(`\\(\\s*${call}\\s*\\)\\.(\\w+)`, "g"))) {
    names.add(name);
  }
  return names;
}

function importProblem(importer, target, modules) {
  const to = ownerOf(target, modules);
  if (!to) return null;
  const from = ownerOf(importer, modules);
  if (from?.module === to.module) return null;
  if (to.part === "schema") return null;
  const registrar = REGISTRARS.some((path) =>
    path.endsWith("/") ? importer.startsWith(path) : importer === path,
  );
  if (to.part === "worker" && registrar) return null;
  if (to.part === "private") return "private";
  if (!from) return to.part === "worker" ? "worker" : null;
  return usesOf(from, modules).includes(to.module) ? null : "uses";
}

function usesOf(from, modules) {
  const { uses, workerUses = [] } = modules[from.module];
  return from.part === "worker" ? [...uses, ...workerUses] : uses;
}

const MESSAGES = {
  private: (target) =>
    `imports ${target}, a module's private folder; go through its surface file instead`,
  uses: (target) =>
    `imports ${target} from another module it does not declare in \`uses\` (scripts/check-modules.mjs)`,
  worker: (target) =>
    `imports ${target}, another module's Worker folder; call that module's door in @omni/db instead`,
  tables: (tables) =>
    `names another module's tables (${tables.join(", ")}); read them through that module's surface file`,
  barrel: (names) =>
    `imports ${names.slice(0, 5).join(", ")}${names.length > 5 ? ` and ${names.length - 5} more` : ""} through a barrel from a module it does not declare in \`uses\``,
  naming: (table) => `table ${table} must be named <module>_* (ADR 0035 decision 3)`,
};

/**
 * Every boundary problem in `files` (a map of repository path to source). Returns
 * `{ file, rule, message }` entries, debt included; `check` filters debt out.
 */
export function findProblems(files, modules = MODULES) {
  const tables = tablesOf(files, modules);
  const problems = [];
  const cache = new Map();
  const origins = (barrel) => {
    if (!cache.has(barrel)) cache.set(barrel, exportOrigins(files, barrel));
    return cache.get(barrel);
  };
  for (const [file, source] of files) {
    if (TEST.test(file) || !SOURCE.test(file)) continue;
    const owner = ownerOf(file, modules);
    problems.push(...barrelProblems(file, source, owner, origins, modules));
    for (const { specifier } of importsOf(source)) {
      const target = resolve(file, specifier);
      const rule = target && importProblem(file, target, modules);
      if (rule) problems.push({ file, rule, message: MESSAGES[rule](target) });
    }
    if (!file.startsWith("packages/db/src/schema/")) {
      const foreign = tablesNamedBy(file, source, tables).filter(
        (identifier) => tables.get(identifier).module !== owner?.module,
      );
      if (foreign.length)
        problems.push({ file, rule: "tables", message: MESSAGES.tables(foreign) });
    }
  }
  for (const [identifier, { module, sqlName, file }] of tables) {
    if (modules[module].prefixed && !sqlName.startsWith(`${module}_`)) {
      problems.push({
        file,
        rule: "naming",
        message: MESSAGES.naming(`${identifier} ("${sqlName}")`),
      });
    }
  }
  return problems;
}

/** The problems that are not debt, and the debt entries that no longer fail. */
export function check(files, modules = MODULES, debt = DEBT) {
  const problems = findProblems(files, modules);
  const isDebt = (p) => debt.some((d) => d.file === p.file && d.rule === p.rule);
  const stale = debt.filter((d) => !problems.some((p) => p.file === d.file && p.rule === d.rule));
  return { problems: problems.filter((p) => !isDebt(p)), stale };
}

function main() {
  const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter((file) => SOURCE.test(file) && !TEST.test(file));
  const files = new Map();
  for (const path of paths) {
    try {
      files.set(path, readFileSync(path, "utf8"));
    } catch {}
  }
  const { problems, stale } = check(files);
  const lines = [
    ...problems.map((p) => `${p.file}: ${p.message}`),
    ...stale.map(
      (d) =>
        `scripts/check-modules.mjs: DEBT lists ${d.file} (${d.rule}), which no longer fails; remove it`,
    ),
  ];
  if (lines.length > 0) {
    console.error(lines.join("\n"));
    process.exit(1);
  }
}

if (import.meta.main) main();
