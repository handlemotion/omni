#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const WEB_ORIGIN = "http://localhost:5173";
const WORKER_ORIGIN = "http://localhost:8787";
const CONTAINERS = ["omni-postgres", "omni-greenmail", "omni-objects"];

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  return result.status === 0;
}

function step(label, command, args) {
  console.log(`dev:stack: ${label}`);
  if (!run(command, args)) {
    console.error(`dev:stack: ${label} failed`);
    process.exit(1);
  }
}

function containersHealthy() {
  const filters = CONTAINERS.flatMap((name) => ["-f", `name=^${name}$`]);
  const result = spawnSync("docker", ["ps", "-q", "-f", "health=healthy", ...filters], {
    encoding: "utf8",
  });
  return result.stdout.trim().split("\n").filter(Boolean).length === CONTAINERS.length;
}

console.log("dev:stack: docker services");
if (!run("docker", ["compose", "up", "-d", "--wait"]) && !containersHealthy()) {
  console.error("dev:stack: docker services are not up; see the compose output above");
  process.exit(1);
}
const useDoppler =
  process.env.OMNI_NO_DOPPLER !== "1" && spawnSync("doppler", ["--version"]).status === 0;
const ENV_FILES = [
  ["packages/db/.env", "packages/db/.env.example"],
  ["apps/mail/.env", "apps/mail/.env.example"],
  ["apps/worker/.dev.vars", "apps/worker/.dev.vars.example"],
];
const LOCAL_SECRETS = {
  MAIL_SERVICE_HMAC_SECRET: randomBytes(32).toString("hex"),
  MAIL_CREDENTIALS_KEY: `k1:${randomBytes(32).toString("base64")}`,
  BETTER_AUTH_SECRET: randomBytes(32).toString("base64"),
  SYSTEM_MAIL_FROM: "omni@example.com",
};
function existingValue(name) {
  for (const [file] of ENV_FILES) {
    if (!existsSync(join(root, file))) continue;
    const match = readFileSync(join(root, file), "utf8").match(new RegExp(`^${name}=(.+)$`, "m"));
    if (match) return match[1].trim();
  }
  return undefined;
}
if (!useDoppler) {
  for (const name of Object.keys(LOCAL_SECRETS)) {
    LOCAL_SECRETS[name] = existingValue(name) ?? LOCAL_SECRETS[name];
  }
  for (const [file, example] of ENV_FILES) {
    if (existsSync(join(root, file))) continue;
    const text = readFileSync(join(root, example), "utf8").replace(/^([A-Z_]+)=$/gm, (line, name) =>
      name in LOCAL_SECRETS ? `${name}=${LOCAL_SECRETS[name]}` : line,
    );
    writeFileSync(join(root, file), text);
    console.log(`dev:stack: wrote ${file} from ${example}`);
  }
}
const pnpmStep = (label, config, args) =>
  useDoppler
    ? step(label, "doppler", ["run", "-p", "omni", "-c", config, "--", "pnpm", ...args])
    : step(label, "pnpm", args);
pnpmStep("migrations", "dev", ["--filter", "@omni/db", "db:migrate"]);
pnpmStep("seed", "dev_mail", ["--filter", "@omni/mail", "dev:seed"]);

const children = [];
let exiting = false;
function stop(code) {
  if (exiting) return;
  exiting = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}
function start(args) {
  const child = spawn("pnpm", args, { cwd: root, stdio: "inherit" });
  child.on("exit", (code) => stop(code ?? 1));
  children.push(child);
  return child;
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(0));

const authUrl = ["--var", `BETTER_AUTH_URL:${WEB_ORIGIN}`];
start(
  useDoppler
    ? ["--filter", "@omni/worker", "dev", ...authUrl]
    : ["--filter", "@omni/worker", "exec", "wrangler", "dev", ...authUrl],
);
const workerUp = () =>
  fetch(`${WORKER_ORIGIN}/health`).then(
    (r) => r.ok,
    () => false,
  );
for (const deadline = Date.now() + 120_000; Date.now() < deadline;) {
  if (exiting || (await workerUp())) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!exiting && useDoppler) {
  start(["exec", "turbo", "run", "dev", "--filter=@omni/web", "--filter=@omni/mail"]);
} else if (!exiting) {
  start(["--filter", "@omni/web", "dev"]);
  start(["--filter", "@omni/mail", "exec", "node", "--watch", "src/main.ts"]);
}
