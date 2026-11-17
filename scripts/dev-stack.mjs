#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
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
const doppler = (config) => ["run", "-p", "omni", "-c", config, "--"];
step("migrations", "doppler", [...doppler("dev"), "pnpm", "--filter", "@omni/db", "db:migrate"]);
step("seed", "doppler", [...doppler("dev_mail"), "pnpm", "--filter", "@omni/mail", "dev:seed"]);

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

start(["--filter", "@omni/worker", "dev", "--var", `BETTER_AUTH_URL:${WEB_ORIGIN}`]);
const workerUp = () =>
  fetch(`${WORKER_ORIGIN}/health`).then(
    (r) => r.ok,
    () => false,
  );
for (const deadline = Date.now() + 120_000; Date.now() < deadline;) {
  if (exiting || (await workerUp())) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!exiting) start(["exec", "turbo", "run", "dev", "--filter=@omni/web", "--filter=@omni/mail"]);
