// A file's live document (ADR 0043 decision 3 step 2): the records of its S2 stream, read by an
// editor that joins or has missed some. Members only: the records go out over the workspace's
// realtime socket, which a shared link's person does not have.
import {
  storageLiveReadQuerySchema,
  storageLiveRecordSchema,
  type StorageLiveEntry,
  type StorageLiveReadResponse,
} from "@omni/contracts";
import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { docStream } from "../realtime-docs.ts";
import { s2Basin } from "../s2.ts";
import { zValidator } from "../validator.ts";
import { memberStorage, refused } from "./http.ts";

export const storageLive = new Hono<AppEnv>().get(
  "/files/:id/live",
  zValidator("query", storageLiveReadQuerySchema),
  async (c) => {
    const basin = s2Basin(c.var.config);
    if (!basin) return c.json({ enabled: false } satisfies StorageLiveReadResponse);
    const found = await memberStorage(c).file(c.req.param("id"));
    if (found.status !== "ok") return refused(c, found.status);
    const read = await basin.read(docStream(found.file.id), c.req.valid("query").from ?? 0);
    const entries: StorageLiveEntry[] = [];
    for (const { seqNum, body } of read.records) {
      // Every record went through the socket's schema; one that does not parse is skipped.
      let parsed;
      try {
        parsed = storageLiveRecordSchema.safeParse(JSON.parse(body));
      } catch {
        continue;
      }
      if (parsed.success) entries.push({ seqNum, record: parsed.data });
    }
    return c.json({ enabled: true, entries, more: read.more } satisfies StorageLiveReadResponse);
  },
);
