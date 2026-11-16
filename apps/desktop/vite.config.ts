// Builds the bundled local shell (`src/`), the only page the app ships (ADR 0043 decision 2).
// The web app itself is never bundled: the main window loads the Omni server's origin.
import { defineConfig } from "vite";

export default defineConfig({
  root: "src",
  // Tauri serves the bundle from its own scheme; relative paths keep assets resolvable there.
  base: "./",
  clearScreen: false,
  // `.env` sits beside this file (`.env.example`), not in `src/`, where `root` would look.
  envDir: import.meta.dirname,
  envPrefix: ["OMNI_DESKTOP_"],
  server: { port: 1420, strictPort: true },
  build: { outDir: "../dist", emptyOutDir: true, target: "es2022" },
});
