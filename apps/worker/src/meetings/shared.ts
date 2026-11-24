import { askMeetingsBodySchema, meetingsListQuerySchema } from "@omni/contracts";
import { meetingsPipeline, storageWorkspaceFile } from "@omni/db";
import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { requireUser, type AppEnv } from "../context.ts";
import { apiError } from "../errors.ts";
import { zValidator } from "../validator.ts";
import { answerAsk } from "./ask.ts";
import { meetingFile } from "./audio.ts";
import { refused, userMeetings, wire } from "./http.ts";
import { meetingEngine } from "./jobs.ts";

const engineOn = createMiddleware<AppEnv>(async (c, next) => {
  if (!meetingEngine(c.var.config, c.env)) return apiError(c, "not_found", "not found");
  await next();
});

/**
 * The user door (`docs/spec/meetings.md`, "Sharing"): a signed-in person, in the workspace or
 * not, reaching the meetings shared with one of their verified addresses. The same grant checks
 * as the member door; a meeting they cannot open answers `404`, and a removed grant closes it at
 * once. Viewing only: changes stay with the workspace's members.
 */
export const meetingsShared = new Hono<AppEnv>()
  .use(engineOn)
  .use(requireUser)
  .get("/", zValidator("query", meetingsListQuerySchema), async (c) => {
    const { before, limit } = c.req.valid("query");
    const listed = await userMeetings(c).list({ before: before ? new Date(before) : null, limit });
    if (listed.status !== "ok") return refused(c, listed);
    return c.json({ meetings: listed.meetings.map(wire) });
  })
  .post("/ask", zValidator("json", askMeetingsBodySchema), async (c) => {
    const { meetingId, question } = c.req.valid("json");
    if (!meetingId) return apiError(c, "bad_request", "ask about one meeting");
    const found = await userMeetings(c).askSources(meetingId);
    if (found.status !== "ok") return refused(c, found);
    return answerAsk(c, question, [...found.meetings]);
  })
  .get("/:id", async (c) => {
    const found = await userMeetings(c).get(c.req.param("id"));
    if (found.status !== "ok") return refused(c, found);
    return c.json({ ...found, meeting: wire(found.meeting) });
  })
  .get("/:id/transcript", async (c) => {
    const found = await userMeetings(c).transcript(c.req.param("id"));
    if (found.status !== "ok") return refused(c, found);
    return c.json({ segments: found.segments });
  })
  .get("/:id/audio", (c) => recording(c, "audio"))
  .get("/:id/video", (c) => recording(c, "video"));

async function recording(c: Context<AppEnv>, kind: "audio" | "video") {
  const found = await userMeetings(c).get(c.req.param("id") ?? "");
  if (found.status !== "ok") return refused(c, found);
  const row = (await meetingsPipeline(c.var.db).meeting(found.meeting.id))?.meeting;
  const nodeId = kind === "video" ? row?.videoNodeId : row?.audioNodeId;
  const file = row && nodeId ? await storageWorkspaceFile(c.var.db, row.orgId, nodeId) : null;
  if (!file) return refused(c, { status: "not_found" });
  return meetingFile(c, file);
}
