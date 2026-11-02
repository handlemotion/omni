import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// The app and its API share one origin: in production the Worker serves both, and in dev Vite
// forwards `/api` (the realtime websocket included) to `wrangler dev`.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const api = env.OMNI_API_ORIGIN || "http://localhost:8787";
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
    ],
    server: {
      port: 5173,
      strictPort: true,
      proxy: { "/api": { target: api, changeOrigin: false, ws: true } },
    },
    build: { sourcemap: true },
  };
});
