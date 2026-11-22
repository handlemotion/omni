import { storageLiveReadQuerySchema, type StorageLiveReadResponse } from "@omni/contracts";
import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { s2Basin } from "../s2.ts";
import { zValidator } from "../validator.ts";
import { memberStorage, refused } from "./http.ts";
import { latestLiveStart, readLivePage } from "./live-read.ts";

export const storageLive = new Hono<AppEnv>().get(
  "/files/:id/live",
  zValidator("query", storageLiveReadQuerySchema),
  async (c) => {
    const basin = s2Basin(c.var.config);
    if (!basin) return c.json({ enabled: false } satisfies StorageLiveReadResponse);
    const found = await memberStorage(c).file(c.req.param("id"));
    if (found.status !== "ok") return refused(c, found.status);
    const nodeId = found.file.id;
    const asked = c.req.valid("query").from ?? 0;
    const from = asked === "latest" ? await latestLiveStart(basin, nodeId) : asked;
    const { entries, more } = await readLivePage(basin, nodeId, from);
    return c.json({ enabled: true, entries, more } satisfies StorageLiveReadResponse);
  },
);
