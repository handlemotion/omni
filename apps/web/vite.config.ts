import { fileURLToPath } from "node:url";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { z } from "zod";

const optional = z
  .string()
  .optional()
  .transform((value) => value || undefined);

// Build-time config, documented in `.env.example`. All optional: without them the app builds
// with error reporting off and its source maps stay in the build.
const envSchema = z.object({
  OMNI_API_ORIGIN: optional.pipe(z.url().optional()),
  /** Sentry DSN for the browser. Public by design (it ships in the bundle), but kept in env. */
  VITE_SENTRY_DSN: optional.pipe(z.url().optional()),
  VITE_SENTRY_ENVIRONMENT: optional,
  /** All three set: upload source maps to Sentry at build, then delete them from the output. */
  SENTRY_AUTH_TOKEN: optional,
  SENTRY_ORG: optional,
  SENTRY_PROJECT: optional,
});

// The app and its API share one origin: in production the Worker serves both, and in dev Vite
// forwards `/api` (the realtime websocket included) to `wrangler dev`.
export default defineConfig(({ mode }) => {
  const parsed = envSchema.safeParse(loadEnv(mode, process.cwd(), ""));
  if (!parsed.success) {
    // Names only: values may be secrets.
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`invalid web build config:\n  ${problems.join("\n  ")}`);
  }
  const env = parsed.data;
  const api = env.OMNI_API_ORIGIN ?? "http://localhost:8787";
  const uploadSourceMaps = Boolean(env.SENTRY_AUTH_TOKEN && env.SENTRY_ORG && env.SENTRY_PROJECT);
  return {
    plugins: [
      // Must run before React: it generates `src/routeTree.gen.ts` and splits each route's
      // component into its own chunk.
      tanstackRouter({
        target: "react",
        autoCodeSplitting: true,
        quoteStyle: "double",
        semicolons: true,
      }),
      react(),
      tailwindcss(),
      // Last, so it sees the final chunks. Off without a token: no network at build.
      uploadSourceMaps &&
        sentryVitePlugin({
          authToken: env.SENTRY_AUTH_TOKEN,
          org: env.SENTRY_ORG,
          project: env.SENTRY_PROJECT,
          sourcemaps: { filesToDeleteAfterUpload: ["./dist/**/*.map"] },
          telemetry: false,
        }),
    ],
    resolve: {
      alias: [
        { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
        // Intent UI imports `cn` and `twJoin` from the `cn` package, and tailwind-variants bundles
        // the same merge engine under the same names. One copy instead of two (~45 kB unminified).
        // The `cn` package stays installed for its types and for components added later.
        { find: /^cn$/, replacement: "tailwind-variants" },
      ],
    },
    server: {
      port: 5173,
      strictPort: true,
      proxy: { "/api": { target: api, changeOrigin: false, ws: true } },
    },
    build: { sourcemap: true },
  };
});
