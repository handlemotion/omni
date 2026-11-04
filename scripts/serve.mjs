#!/usr/bin/env node
// Serves the real stack for UI checks: the Worker under `wrangler dev`, serving the built web app
// (wrangler.jsonc `build`, rebuilt when apps/web/src changes) against the local Postgres from
// `pnpm stack:up`. The server is fully detached: its stdin, stdout and stderr are a log file, it
// leads its own process group, and its pid is on disk. So `start` returns as soon as `/health`
// answers, even when piped (`pnpm stack:serve | tail`), and the server outlives the caller.
//
//   node scripts/serve.mjs start | stop | status     (pnpm stack:serve / stack:serve:stop)
//
// PORT (default 8787) picks the port. Sign in with the magic links the Worker logs as
// `auth.dev_link` (ENVIRONMENT=development, the .dev.vars.example default).
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const worker = join(root, "apps/worker");
const stateDir = join(root, ".local/serve");
const pidFile = join(stateDir, "worker.pid");
const logFile = join(stateDir, "worker.log");
const port = Number(process.env.PORT ?? 8787);
const url = `http://127.0.0.1:${port}`;
const readyTimeoutMs = 180_000;

function runningPid() {
  if (!existsSync(pidFile)) return undefined;
  const pid = Number(readFileSync(pidFile, "utf8"));
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    rmSync(pidFile, { force: true });
    return undefined;
  }
}

async function healthy() {
  try {
    return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) })).ok;
  } catch {
    return false;
  }
}

function tail(lines = 30) {
  if (!existsSync(logFile)) return "";
  return readFileSync(logFile, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
}

async function start() {
  const pid = runningPid();
  if (pid) {
    console.log(`Worker already running (pid ${pid}): ${url}  log: ${logFile}`);
    return;
  }
  const devVars = join(worker, ".dev.vars");
  if (!existsSync(devVars)) {
    copyFileSync(join(worker, ".dev.vars.example"), devVars);
    console.log("apps/worker/.dev.vars was missing; copied .dev.vars.example");
  }
  mkdirSync(stateDir, { recursive: true });
  const log = openSync(logFile, "w");
  const child = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--show-interactive-dev-session=false",
    ],
    { cwd: worker, detached: true, stdio: [log, log, log] },
  );
  child.unref();
  writeFileSync(pidFile, String(child.pid));

  let exited = false;
  child.on("exit", () => (exited = true));
  const deadline = Date.now() + readyTimeoutMs;
  while (!(await healthy())) {
    if (exited || Date.now() > deadline) {
      console.error(
        `Worker did not become ready${exited ? " (it exited)" : ""}. Log tail:\n${tail()}`,
      );
      stop({ quiet: true });
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.log(`Worker ready (pid ${child.pid}): ${url}  log: ${logFile}`);
  // Exit now: the child holds none of our fds, so nothing keeps the caller's pipe open.
  process.exit(0);
}

function stop({ quiet = false } = {}) {
  const pid = runningPid();
  if (!pid) {
    if (!quiet) console.log("Worker not running");
    return;
  }
  // The whole group: pnpm, wrangler, workerd and the web build share it.
  try {
    process.kill(-pid, "SIGTERM");
  } catch {}
  rmSync(pidFile, { force: true });
  if (!quiet) console.log(`Worker stopped (pid ${pid})`);
}

async function status() {
  const pid = runningPid();
  const ok = pid ? await healthy() : false;
  console.log(
    pid ? `Worker pid ${pid}, ${ok ? "healthy" : "not answering"}: ${url}` : "Worker not running",
  );
  process.exit(ok ? 0 : 1);
}

const command = process.argv[2] ?? "start";
if (command === "start") await start();
else if (command === "stop") stop();
else if (command === "status") await status();
else {
  console.error("usage: node scripts/serve.mjs start | stop | status");
  process.exit(2);
}
