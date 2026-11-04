// Bundles the service into dist/main.js and the CLIs into dist/mailbox-add.js and
// dist/dead-letters.js. Workspace packages (@omni/*) ship as TypeScript source,
// so they are bundled in; every npm import stays external and resolves from the flat
// node_modules that `pnpm deploy --prod` (hoisted) writes in the image.
import { build } from "esbuild";

await build({
  entryPoints: {
    main: "src/main.ts",
    "mailbox-add": "src/cli/mailbox-add.ts",
    "dead-letters": "src/cli/dead-letters.ts",
  },
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node26",
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
