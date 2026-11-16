// Runs one mailbox's first sync in a process of its own, so the caller can cap its heap the way
// a small VM does and read what the import really cost. Input: FIRST_SYNC (JSON). Output: one
// JSON line with the messages stored, the seconds taken and the process's peak resident memory.
import { createDb } from "@omni/db";
import { MailboxConnection, type MailboxConfig } from "../../src/mailbox-connection.ts";
import { createS3Store, type S3Options } from "../../src/objects.ts";
import { PgMailStore } from "../../src/pg-store.ts";
import { logger } from "./greenmail.ts";
import { links } from "./objects.ts";

export interface FirstSyncInput {
  databaseUrl: string;
  bucket: S3Options;
  box: MailboxConfig;
}

export interface FirstSyncOutput {
  messages: number;
  seconds: number;
  peakRssMb: number;
}

const input = JSON.parse(process.env.FIRST_SYNC ?? "") as FirstSyncInput;
const { db, close } = createDb(input.databaseUrl, { max: 5 });
const store = new PgMailStore({ db, objects: createS3Store(input.bucket), links });
const connection = new MailboxConnection(input.box, { store, logger });
let messages = 0;
connection.on("message", () => messages++);

const started = performance.now();
await connection.start();
const seconds = (performance.now() - started) / 1000;
await connection.stop();
await close();
// `maxRSS` is in kilobytes on Linux and macOS.
const output: FirstSyncOutput = {
  messages,
  seconds,
  peakRssMb: process.resourceUsage().maxRSS / 1024,
};
process.stdout.write(`${JSON.stringify(output)}\n`);
