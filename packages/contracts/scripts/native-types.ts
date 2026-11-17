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

function jsonSchemas() {
  const registry = z.registry<{ id: string }>();
  for (const [name, schema] of Object.entries(STORAGE_SYNC_NATIVE_TYPES)) {
    registry.add(schema, { id: name });
  }
  const { schemas } = z.toJSONSchema(registry, {
    io: "input",
    unrepresentable: "any",
    uri: (id) => id,
  });
  return Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => {
      const plain = JSON.parse(JSON.stringify(schema), dropDateTimeFormat);
      delete plain.$schema;
      delete plain.$id;
      return [name, plain];
    }),
  ) satisfies Record<string, unknown>;
}

function dropDateTimeFormat(key: string, value: unknown) {
  return key === "format" && value === "date-time" ? undefined : value;
}

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
