import { importForeignMeeting } from "@omni/ai";
import { importMeetingBodySchema } from "@omni/contracts";
import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { zValidator } from "../validator.ts";
import { memberMeetings, refused } from "./http.ts";
import { announceMeeting } from "./jobs.ts";

/**
 * `POST /api/meetings/import` (`docs/spec/meetings.md`, "Importing"): a meeting another
 * notetaker recorded, in Circleback's webhook and API shape, filed as the caller's own and
 * already `ready`. Transcript and notes only, so no meeting minutes are counted and no model is
 * called; no notes doc is written, since that doc says Omni wrote it from the recording. The same
 * `id` again answers `200` with the first import's meeting.
 */
export const meetingImport = new Hono<AppEnv>().post(
  "/import",
  zValidator("json", importMeetingBodySchema),
  async (c) => {
    const body = c.req.valid("json");
    const meeting = importForeignMeeting(body);
    const imported = await memberMeetings(c).import({
      source: body.source,
      sourceId: body.id,
      ...meeting,
    });
    if (imported.status !== "ok") return refused(c, imported);
    const { meetingId, created } = imported;
    if (created) {
      const orgId = c.var.member.orgId;
      const run = { env: c.env, db: c.var.db, config: c.var.config, log: c.var.log };
      await announceMeeting(run, orgId, meetingId, "ready");
    }
    return c.json({ meetingId, created }, created ? 201 : 200);
  },
);
