import { build } from "esbuild";

await build({
  entryPoints: {
    main: "src/main.ts",
    "mailbox-add": "src/cli/mailbox-add.ts",
    "dead-letters": "src/cli/dead-letters.ts",
    "google-connect": "src/cli/google-connect.ts",
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
