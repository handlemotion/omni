// Bundles the service into dist/main.js. npm dependencies stay external (installed by
// `pnpm deploy --prod` in the image); workspace packages (@omni/*) ship as TypeScript source, so
// they are bundled in.
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const { dependencies = {} } = JSON.parse(readFileSync("package.json", "utf8"));

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: true,
  external: Object.keys(dependencies).filter((name) => !name.startsWith("@omni/")),
});
