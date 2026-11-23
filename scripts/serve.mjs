#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureEnvFile, isHealthy, waitForHealth } from "./local-env.mjs";

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

function readOr(path, fallback) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return fallback;
  }
}

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
    while (await isHealthy(url)) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const devVars = join(worker, ".dev.vars");
  const secrets = {
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    MAIL_SERVICE_HMAC_SECRET: randomBytes(32).toString("hex"),
  };
  if (ensureEnvFile(devVars, join(worker, ".dev.vars.example"), secrets)) {
    console.log("apps/worker/.dev.vars was missing; copied .dev.vars.example with local secrets");
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
  if (!(await waitForHealth(url, Date.now() + readyTimeoutMs, () => exited))) {
    console.error(
      `Worker did not become ready${exited ? " (it exited)" : ""}. Log tail:\n${tail()}`,
    );
    stop({ quiet: true });
    process.exit(1);
  }
  console.log(`Worker ready (pid ${child.pid}): ${url}  log: ${logFile}`);
  process.exit(0);
}

function stop({ quiet = false } = {}) {
  const pid = runningPid();
  if (!pid) {
    if (!quiet) console.log("Worker not running");
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {}
  rmSync(pidFile, { force: true });
  if (!quiet) console.log(`Worker stopped (pid ${pid})`);
}

async function status() {
  const pid = runningPid();
  const ok = pid ? await isHealthy(url) : false;
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
