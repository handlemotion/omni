import { defineConfig } from "vite";

export default defineConfig({
  root: "src",
  base: "./",
  clearScreen: false,
  envDir: import.meta.dirname,
  envPrefix: ["OMNI_DESKTOP_"],
  server: { port: 1420, strictPort: true },
  build: { outDir: "../dist", emptyOutDir: true, target: "es2022" },
});
