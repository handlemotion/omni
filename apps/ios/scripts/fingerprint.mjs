import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appRequire = createRequire(path.join(appDir, "package.json"));
const expoRequire = createRequire(appRequire.resolve("expo/package.json"));
const { createFingerprintAsync } = expoRequire("@expo/fingerprint");

const result = await createFingerprintAsync(appDir, {
  platforms: ["ios"],
  ignorePaths: ["ios/**"],
});

process.stdout.write(`${result.hash}\n`);
