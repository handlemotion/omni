import { fileURLToPath } from "node:url";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { z } from "zod";

const optional = z
  .string()
  .optional()
  .transform((value) => value || undefined);

const envSchema = z.object({
  OMNI_API_ORIGIN: optional.pipe(z.url().optional()),
  VITE_SENTRY_DSN: optional.pipe(z.url().optional()),
  VITE_SENTRY_ENVIRONMENT: optional,
  SENTRY_AUTH_TOKEN: optional,
  SENTRY_ORG: optional,
  SENTRY_PROJECT: optional,
});

const hairlinePureFigures: Plugin = {
  name: "omni:hairline-pure-figures",
  transform: {
    filter: { id: /@lucasmarkes[\\/]hairline[\\/]dist[\\/]react\.js$/ },
    handler: (code) => ({ code: code.replace(/= make\(/g, "= /* @__PURE__ */ make("), map: null }),
  },
};

export default defineConfig(({ mode }) => {
  const parsed = envSchema.safeParse(loadEnv(mode, process.cwd(), ""));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`invalid web build config:\n  ${problems.join("\n  ")}`);
  }
  const env = parsed.data;
  const api = env.OMNI_API_ORIGIN ?? "http://localhost:8787";
  const uploadSourceMaps = Boolean(env.SENTRY_AUTH_TOKEN && env.SENTRY_ORG && env.SENTRY_PROJECT);
  return {
    plugins: [
      tanstackRouter({
        target: "react",
        autoCodeSplitting: true,
        quoteStyle: "double",
        semicolons: true,
      }),
      react(),
      tailwindcss(),
      hairlinePureFigures,
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
        { find: /^cn$/, replacement: "tailwind-variants" },
        { find: /^pdfjs-dist$/, replacement: "pdfjs-dist/legacy/build/pdf.mjs" },
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
