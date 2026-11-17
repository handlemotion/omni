#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "..");
const PLACEHOLDER = '"id": "00000000000000000000000000000000"';

const hyperdrive = process.env.HYPERDRIVE_ID;
if (!hyperdrive || !/^[0-9a-f]{32}$/.test(hyperdrive)) {
  console.error("HYPERDRIVE_ID is missing or not a 32-character Hyperdrive id");
  process.exit(1);
}

const config = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
if (!config.includes(PLACEHOLDER)) {
  console.error("wrangler.jsonc no longer has the Hyperdrive placeholder id this script replaces");
  process.exit(1);
}
const deployConfig = join(dir, "wrangler.deploy.jsonc");
writeFileSync(deployConfig, config.replace(PLACEHOLDER, `"id": "${hyperdrive}"`));

const args = ["exec", "wrangler", "deploy", "--config", deployConfig, ...process.argv.slice(2)];
for (const [name, value] of Object.entries(process.env)) {
  if (name.startsWith("WORKER_VAR_") && value !== undefined) {
    args.push("--var", `${name.slice("WORKER_VAR_".length)}:${value}`);
  }
}
for (const domain of (process.env.WORKER_DOMAIN ?? "").split(",")) {
  if (domain.trim()) args.push("--domain", domain.trim());
}

const result = spawnSync("pnpm", args, { cwd: dir, stdio: "inherit" });
rmSync(deployConfig, { force: true });
process.exit(result.status ?? 1);
