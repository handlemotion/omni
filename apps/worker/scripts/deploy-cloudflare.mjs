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
writeFileSync(
  deployConfig,
  withPlacement(config.replace(PLACEHOLDER, `"id": "${hyperdrive}"`), process.env.WORKER_PLACEMENT),
);

const outdir = join(dir, "dist");
const args = [
  "exec",
  "wrangler",
  "deploy",
  "--config",
  deployConfig,
  "--outdir",
  outdir,
  ...process.argv.slice(2),
];
for (const [name, value] of Object.entries(process.env)) {
  if (name.startsWith("WORKER_VAR_") && value !== undefined) {
    args.push("--var", `${name.slice("WORKER_VAR_".length)}:${value}`);
  }
}
for (const domain of (process.env.WORKER_DOMAIN ?? "").split(",")) {
  if (domain.trim()) args.push("--domain", domain.trim());
}

const result = spawnSync("pnpm", args, { cwd: dir, stdio: ["inherit", "pipe", "inherit"] });
const output = result.stdout?.toString() ?? "";
process.stdout.write(output);
rmSync(deployConfig, { force: true });
if (result.status === 0) uploadSourceMapsToSentry(output);
rmSync(outdir, { recursive: true, force: true });
process.exit(result.status ?? 1);

function uploadSourceMapsToSentry(deployOutput) {
  const { SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_WORKER_PROJECT } = process.env;
  if (!SENTRY_AUTH_TOKEN || !SENTRY_ORG || !SENTRY_WORKER_PROJECT) return;
  const version = deployOutput.match(/Current Version ID: ([0-9a-f-]{36})/)?.[1];
  if (!version) {
    console.error("sentry: no version id in the deploy output; source maps not uploaded");
    return;
  }
  const upload = spawnSync(
    "pnpm",
    [
      "exec",
      "sentry-cli",
      "sourcemaps",
      "upload",
      `--project=${SENTRY_WORKER_PROJECT}`,
      `--release=${version}`,
      "--strip-prefix",
      dir,
      outdir,
    ],
    { cwd: dir, stdio: "inherit" },
  );
  if (upload.status !== 0) console.error("sentry: source map upload failed; the deploy stands");
}

function withPlacement(config, placement) {
  const value = placement?.trim();
  if (!value) return config;
  let entry;
  if (value === "smart") entry = { mode: "smart" };
  else if (/^(aws|gcp|azure):[a-z0-9-]+$/.test(value)) entry = { region: value };
  else {
    console.error(
      `WORKER_PLACEMENT must be "smart" or a cloud region like aws:us-east-1: ${value}`,
    );
    process.exit(1);
  }
  const anchor = '"keep_vars": true,';
  if (!config.includes(anchor)) {
    console.error(`wrangler.jsonc no longer has ${anchor}, which the placement goes after`);
    process.exit(1);
  }
  return config.replace(anchor, `${anchor}\n  "placement": ${JSON.stringify(entry)},`);
}
