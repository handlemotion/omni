import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Writes `file` from `example` when it is missing, filling each empty `NAME=` line that `secrets`
 * has a value for. Returns whether it wrote the file; an existing file is never touched.
 */
export function ensureEnvFile(file, example, secrets) {
  if (existsSync(file)) return false;
  const text = readFileSync(example, "utf8").replace(/^([A-Z_]+)=$/gm, (line, name) =>
    name in secrets ? `${name}=${secrets[name]}` : line,
  );
  try {
    writeFileSync(file, text, { flag: "wx" });
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

/** Whether `origin` answers `GET /health` within two seconds. */
export async function isHealthy(origin) {
  try {
    return (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2_000) })).ok;
  } catch {
    return false;
  }
}

/** Polls `origin`'s health until it answers, `deadline` (epoch ms) passes or `aborted()` is true. */
export async function waitForHealth(origin, deadline, aborted = () => false) {
  while (!(await isHealthy(origin))) {
    if (aborted() || Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return true;
}
