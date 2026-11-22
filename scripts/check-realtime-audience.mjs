import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HELPER = "apps/worker/src/realtime-files.ts";
const BARE = /\bgetWebSockets\(\s*\)/g;

/** `file:line` of each bare `getWebSockets()` in `files` outside `insiders()` itself. */
export function findBareListings(files) {
  const problems = [];
  for (const [file, source] of files) {
    const lines = source.split("\n");
    lines.forEach((line, index) => {
      if (!BARE.test(line)) return;
      BARE.lastIndex = 0;
      const inHelper = file === HELPER && /tag === undefined \? ctx\.getWebSockets\(\)/.test(line);
      const outsiders = /isOutsider\(/.test(line);
      if (!inHelper && !outsiders) problems.push(`${file}:${index + 1}`);
    });
  }
  return problems;
}

function main() {
  const dir = "apps/worker/src";
  const files = new Map(
    readdirSync(dir)
      .filter((name) => /^realtime.*\.ts$/.test(name))
      .map((name) => [join(dir, name), readFileSync(join(dir, name), "utf8")]),
  );
  const problems = findBareListings(files);
  if (problems.length > 0) {
    console.error(
      problems
        .map(
          (where) =>
            `${where}: list the workspace's sockets with insiders(ctx), not getWebSockets()`,
        )
        .join("\n"),
    );
    process.exit(1);
  }
}

if (import.meta.main) main();
