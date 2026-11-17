import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const UNIT_TEST_ROOTS = ["packages/mail-core/", "packages/ai/", "packages/crypto/", "scripts/"];

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  encoding: "utf8",
})
  .split("\n")
  .filter((file) => /\.test\.(ts|tsx|mts|mjs)$/.test(file));

const problems = [];

for (const file of files) {
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const e2e = /\.e2e\.test\./.test(file);

  if (!e2e && !UNIT_TEST_ROOTS.some((root) => file.startsWith(root))) {
    problems.push(
      `${file}: unit tests are allowed only in ${UNIT_TEST_ROOTS.join(", ")}; prove this behavior in a *.e2e.test.ts instead`,
    );
  }
  if (
    e2e &&
    /\bvi\.(mock|doMock|stubGlobal)\(|mockImplementation\(|mockResolvedValue\(/.test(source)
  ) {
    problems.push(`${file}: e2e tests run against real dependencies and must not mock`);
  }
  if (/\b(it|test|describe)\.(only|skip|todo)\b|\b(fit|xit|xdescribe)\(/.test(source)) {
    problems.push(`${file}: no .only, .skip, or .todo`);
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
