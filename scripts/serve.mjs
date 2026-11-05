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
//
// PUBLIC_ORIGIN (set by `pnpm share`, scripts/share.mjs) is the origin a browser elsewhere uses,
// e.g. https://omni-x.tail1234.ts.net:8787. The Worker then takes it as BETTER_AUTH_URL and
// WEB_APP_URL (so magic links, cookies and passkeys use it) and still trusts the local origins.
// A running Worker started without that origin is restarted; without PUBLIC_ORIGIN, `start` keeps
// whatever is running.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  constants,
  copyFileSync,
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
const originFile = join(stateDir, "origin");
const port = Number(process.env.PORT ?? 8787);
const url = `http://127.0.0.1:${port}`;
const readyTimeoutMs = 180_000;
const publicOrigin = process.env.PUBLIC_ORIGIN ?? "";

/** The file's text, or `fallback` when it does not exist (read once: no check-then-read race). */
function readOr(path, fallback) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return fallback;
  }
}

/** One plain `KEY=value` line from a .dev.vars file, or undefined. */
function devVar(path, key) {
  const line = readOr(path, "")
    .split("\n")
    .find((l) => l.startsWith(`${key}=`));
  return line?.slice(key.length + 1).trim();
}

function runningPid() {
  const pid = Number(readOr(pidFile, ""));
  if (!pid) return undefined;
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
  return readOr(logFile, "").trimEnd().split("\n").slice(-lines).join("\n");
}

async function start() {
  const pid = runningPid();
  if (pid && (!publicOrigin || readOr(originFile, "") === publicOrigin)) {
    console.log(`Worker already running (pid ${pid}): ${url}  log: ${logFile}`);
    return;
  }
  if (pid) {
    stop();
    while (await healthy()) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const devVars = join(worker, ".dev.vars");
  try {
    // COPYFILE_EXCL: copy only when missing, in one step (never overwrite a hand-made file).
    copyFileSync(join(worker, ".dev.vars.example"), devVars, constants.COPYFILE_EXCL);
    // The example leaves the signing secrets empty, and config validation rejects every auth
    // request without them: give this local copy random ones.
    const filled = readFileSync(devVars, "utf8").replace(
      /^(BETTER_AUTH_SECRET|MAIL_SERVICE_HMAC_SECRET)=$/gm,
      (_, key) => `${key}=${randomBytes(32).toString("hex")}`,
    );
    writeFileSync(devVars, filled);
    console.log("apps/worker/.dev.vars was missing; copied .dev.vars.example with local secrets");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  mkdirSync(stateDir, { recursive: true });
  const vars = [];
  if (publicOrigin) {
    const local = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
    const trusted = [...local, ...(devVar(devVars, "AUTH_TRUSTED_ORIGINS")?.split(",") ?? [])];
    vars.push(
      `BETTER_AUTH_URL:${publicOrigin}`,
      `WEB_APP_URL:${publicOrigin}`,
      `AUTH_TRUSTED_ORIGINS:${trusted.filter(Boolean).join(",")}`,
    );
  }
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
      ...vars.flatMap((v) => ["--var", v]),
    ],
    { cwd: worker, detached: true, stdio: [log, log, log] },
  );
  child.unref();
  writeFileSync(pidFile, String(child.pid));
  writeFileSync(originFile, publicOrigin);

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
