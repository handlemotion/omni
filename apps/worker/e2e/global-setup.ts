// Vitest globalSetup for every suite that starts the Worker (worker, client, web e2e).
//
// Starting the Worker from `wrangler.jsonc` runs its custom build (the whole web app) and bundles
// the Worker every time: about 9 s per start. This builds once with
// `wrangler deploy --dry-run --outdir`, which `startWorker` and `startWorkerWithNetwork` in
// ./support.ts then load as is. The build is reused while its inputs are unchanged, and a
// lock keeps concurrent runs (turbo starts several e2e packages at once) from rebuilding
// `apps/web/dist` under each other.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const workerRoot = join(import.meta.dirname, "..");
const repoRoot = join(workerRoot, "../..");
export const prebuiltWorkerDir = join(workerRoot, ".wrangler/e2e-build");
const stampFile = join(prebuiltWorkerDir, ".inputs");
const lockDir = join(workerRoot, ".wrangler/e2e-build.lock");

// What the bundle and the web build read. Tests and build outputs are not inputs.
const inputs = ["apps/worker", "apps/web", "packages", "pnpm-lock.yaml"];
const skip = new Set(["node_modules", "dist", "e2e", ".tsbuild", ".wrangler", ".turbo"]);

/** A fingerprint of every input file's path, size and mtime: cheap, and changes on any edit. */
function fingerprint() {
  const hash = createHash("sha256");
  const walk = (path: string) => {
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).toSorted())
        if (!skip.has(entry)) walk(join(path, entry));
    } else {
      hash.update(`${relative(repoRoot, path)}:${stat.size}:${stat.mtimeMs}\n`);
    }
  };
  for (const input of inputs) walk(join(repoRoot, input));
  return hash.digest("hex");
}

async function withLock<T>(run: () => T): Promise<T> {
  mkdirSync(join(workerRoot, ".wrangler"), { recursive: true });
  const deadline = Date.now() + 300_000;
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, "pid"), String(process.pid));
      break;
    } catch {
      // A holder that died (killed run) leaves its lock behind; take it over.
      const pid = readPid();
      if (pid && !isAlive(pid)) rmSync(lockDir, { recursive: true, force: true });
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${lockDir}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  try {
    return run();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

/** The file's text, or `fallback` when it does not exist (read once: no check-then-read race). */
function readOr(path: string, fallback: string) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return fallback;
  }
}

function readPid() {
  return Number(readOr(join(lockDir, "pid"), "0"));
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export default async function setup() {
  await withLock(() => {
    const current = fingerprint();
    const built = readOr(stampFile, "");
    if (built === current) return;
    rmSync(prebuiltWorkerDir, { recursive: true, force: true });
    execFileSync(
      "pnpm",
      ["exec", "wrangler", "deploy", "--dry-run", "--outdir", prebuiltWorkerDir],
      { cwd: workerRoot, stdio: ["ignore", "ignore", "inherit"] },
    );
    writeFileSync(stampFile, current);
  });
}
