// Lists work that will not run again, newest first: AI queue jobs that reached the dead-letter
// queue, and outbox actions that exhausted their retries. Each with its error and the request ID
// that started it, to search the Worker's and this service's logs for.
//
//   pnpm --filter @omni/mail dead-letters [--org <org id>] [--since 24h] [--limit 50] [--json]
//
// Operator tool: reads every org through DATABASE_URL. Prints ids, errors and request IDs only,
// never payloads (an outbox payload is the message itself).
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { createDb, listDeadLetters } from "@omni/db";
import { z } from "zod";

const USAGE = `Usage: dead-letters [--org <org id>] [--since <n>m|h|d] [--limit <n>] [--json]`;

function fail(message: string): never {
  console.error(`dead-letters: ${message}\n\n${USAGE}`);
  process.exit(1);
}

function since(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d+)([mhd])$/.exec(value);
  if (!match) fail(`bad --since "${value}"`);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "m" | "h" | "d"];
  return new Date(Date.now() - Number(match[1]) * unit);
}

if (existsSync(".env")) process.loadEnvFile(".env");

const { values } = parseArgs({
  options: {
    org: { type: "string" },
    since: { type: "string" },
    limit: { type: "string", default: "50" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
const limit = Number(values.limit);
if (!Number.isInteger(limit) || limit <= 0) fail(`bad --limit "${values.limit}"`);

const env = z
  .object({ DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }) })
  .safeParse(process.env);
if (!env.success) fail("DATABASE_URL is not set");

const { db, close } = createDb(env.data.DATABASE_URL, { max: 1, onnotice: () => {} });
try {
  const entries = await listDeadLetters(db, {
    limit,
    since: since(values.since),
    orgId: values.org,
  });
  if (values.json) {
    for (const entry of entries) console.log(JSON.stringify(entry));
  } else if (entries.length === 0) {
    console.log("No dead letters.");
  } else {
    for (const e of entries) {
      console.log(
        [
          e.at.toISOString(),
          e.source.padEnd(6),
          e.kind.padEnd(11),
          `id=${e.id}`,
          `org=${e.orgId}`,
          `request=${e.requestId ?? "-"}`,
          `attempts=${e.attempts}`,
        ].join("  "),
      );
      console.log(
        `    ${Object.entries(e.ref)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join("  ")}`,
      );
      console.log(`    error: ${e.error ?? "(none recorded: the consumer stopped mid-job)"}`);
    }
  }
} finally {
  await close();
}
