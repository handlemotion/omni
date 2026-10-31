import { spawnSync } from "node:child_process";

if (process.env.CI === "true") process.exit(0);
if (spawnSync("git", ["rev-parse", "--git-dir"], { stdio: "ignore" }).status !== 0) process.exit(0);

const install = spawnSync("lefthook", ["install"], { stdio: "inherit" });
if (install.error) {
  console.warn(`Skipping git hook install: ${install.error.message}`);
  process.exit(0);
}
process.exit(install.status ?? 0);
