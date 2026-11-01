// Bundles the service into dist/main.js. Workspace packages (@omni/*) ship as TypeScript source,
// so they are bundled in; every npm import stays external and resolves from the flat
// node_modules that `pnpm deploy --prod` (hoisted) writes in the image.
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: true,
  plugins: [
    {
      name: "external-npm",
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) =>
          args.path.startsWith("@omni/") ? undefined : { path: args.path, external: true },
        );
      },
    },
  ],
});
