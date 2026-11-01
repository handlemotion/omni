// Workflow policy (supply chain). Fails when a GitHub Actions workflow or composite action uses
// an action by a mutable ref. Every `uses:` must be one of:
//
// 1. `owner/repo[/path]@<40-char commit SHA> # <version>`: the comment keeps Dependabot and
//    reviewers able to tell what the SHA is.
// 2. A local action (`./path`).
// 3. A Docker image pinned by digest (`docker://image@sha256:<64 hex>`).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  encoding: "utf8",
})
  .split("\n")
  .filter((file) => /^\.github\/.*\.ya?ml$/.test(file));

const USES = /^\s*(?:-\s+)?uses:\s*(["']?)([^"'\s#]+)\1\s*(?:#\s*(\S.*))?$/;
const SHA_PINNED = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/;
const DIGEST_PINNED = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/;

const problems = [];

for (const file of files) {
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    continue; // deleted in the working tree
  }
  source.split("\n").forEach((line, index) => {
    const match = USES.exec(line);
    if (!match) return;
    const [, , ref, comment] = match;
    const where = `${file}:${index + 1}`;
    if (ref.startsWith("./") || DIGEST_PINNED.test(ref)) return;
    if (!SHA_PINNED.test(ref)) {
      problems.push(`${where}: pin ${ref} to a full commit SHA (uses: owner/repo@<sha> # vX.Y.Z)`);
    } else if (!comment) {
      problems.push(`${where}: add the version the SHA points to as a comment (# vX.Y.Z)`);
    }
  });
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
