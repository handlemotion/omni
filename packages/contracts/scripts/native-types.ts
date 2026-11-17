// Generates the desktop sync providers' wire types (ADR 0043 decision 6): Swift `Codable` for the
// macOS File Provider extension and Rust `serde` for the Tauri shell and the Windows provider,
// from the zod schemas in `src/storage.ts` (`STORAGE_SYNC_NATIVE_TYPES`), through JSON Schema
// and quicktype. Nobody hand-writes a response shape in Swift or Rust.
//
//   node scripts/native-types.ts          write the files
//   node scripts/native-types.ts --check  fail when a checked-in file is stale (`pnpm check`)
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InputData, JSONSchemaInput, JSONSchemaStore, quicktype } from "quicktype-core";
import type { JSONSchema } from "quicktype-core";
import { z } from "zod";
import { STORAGE_SYNC_NATIVE_TYPES } from "../src/storage.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const outDir = join(root, "apps/desktop/generated");

const HEADER = "Generated from @omni/contracts by packages/contracts/scripts/native-types.ts.";
const REGENERATE = "Do not edit: run `pnpm --filter @omni/contracts native-types`.";

const TARGETS = [
  {
    lang: "swift",
    file: "swift/StorageSync.swift",
    comment: "//",
    rendererOptions: {
      "struct-or-class": "struct",
      "access-level": "public",
      "acronym-style": "camel",
      protocol: "equatable",
      "swift-5-support": "true",
    },
  },
  {
    lang: "rust",
    file: "rust/storage_sync.rs",
    comment: "//",
    rendererOptions: {
      density: "normal",
      visibility: "public",
      "derive-debug": "true",
      "derive-clone": "true",
      "derive-partial-eq": "true",
      "skip-serializing-none": "true",
      "leading-comments": "false",
    },
  },
] as const;

/**
 * Each named type as its own JSON Schema, keyed by its name. A schema used inside another (a
 * node in a list) is a `$ref` to its name, so it stays one type in Swift and Rust.
 */
function jsonSchemas() {
  const registry = z.registry<{ id: string }>();
  for (const [name, schema] of Object.entries(STORAGE_SYNC_NATIVE_TYPES)) {
    registry.add(schema, { id: name });
  }
  // `input`: requests are typed as the route reads them, so `nullish` and `coerce` show up as a
  // client may write them. Responses have neither, so both directions read the same.
  const { schemas } = z.toJSONSchema(registry, {
    io: "input",
    unrepresentable: "any",
    uri: (id) => id,
  });
  return Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => {
      // `$id` would make quicktype resolve refs against it instead of the store's names.
      const plain = JSON.parse(JSON.stringify(schema), dropDateTimeFormat);
      delete plain.$schema;
      delete plain.$id;
      return [name, plain];
    }),
  ) satisfies Record<string, unknown>;
}

/**
 * Dates stay ISO 8601 strings in Swift and Rust. quicktype would make Swift `Date`s decoded with
 * `.iso8601`, which refuses the fractional seconds the Worker sends; each provider parses the
 * few dates it reads itself.
 */
function dropDateTimeFormat(key: string, value: unknown) {
  return key === "format" && value === "date-time" ? undefined : value;
}

/**
 * Serves each type by its name. quicktype makes one type per address, so a `$ref` to another
 * type's address reuses it; refs inside one document (`#/$defs/...`) would each get a copy.
 */
class NamedSchemaStore extends JSONSchemaStore {
  readonly #schemas = jsonSchemas();

  async fetch(address: string) {
    return this.#schemas[address.replace(/#.*$/, "")] as JSONSchema | undefined satisfies
      | JSONSchema
      | undefined;
  }
}

async function render(target: (typeof TARGETS)[number]) {
  const input = new JSONSchemaInput(new NamedSchemaStore());
  for (const name of Object.keys(STORAGE_SYNC_NATIVE_TYPES)) {
    await input.addSource({ name, uris: [name] });
  }
  const inputData = new InputData();
  inputData.addInput(input);
  const { lines } = await quicktype({
    inputData,
    lang: target.lang,
    rendererOptions: target.rendererOptions,
    inferEnums: false,
  });
  const header = [HEADER, REGENERATE].map((line) => `${target.comment} ${line}`);
  return `${[...header, "", ...lines].join("\n").trimEnd()}\n`;
}

const check = process.argv.includes("--check");
let stale = 0;
for (const target of TARGETS) {
  const path = join(outDir, target.file);
  const text = await render(target);
  if (check) {
    const current = await readFile(path, "utf8").catch(() => "");
    if (current !== text) {
      stale += 1;
      console.error(`stale: apps/desktop/generated/${target.file}`);
    }
    continue;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  console.log(`wrote apps/desktop/generated/${target.file}`);
}
if (stale > 0) {
  console.error("Run `pnpm --filter @omni/contracts native-types` and commit the result.");
  process.exit(1);
}
