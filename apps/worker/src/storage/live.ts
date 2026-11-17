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
