import {
  changeMeetingBodySchema,
  grantMeetingBodySchema,
  meetingsListQuerySchema,
  meetingsSearchQuerySchema,
  renameSpeakerBodySchema,
  startMeetingBodySchema,
  stopMeetingBodySchema,
} from "@omni/contracts";
import { forMember, groupKeyFor, meetingsPipeline, storageWorkspaceFile } from "@omni/db";
import { Hono, type Context } from "hono";
import { gateMeter, hasAllowance } from "../billing.ts";
import type { AppEnv } from "../context.ts";
import { apiError } from "../errors.ts";
import { zValidator } from "../validator.ts";
import { meetingFile } from "./audio.ts";
import { memberFiles, memberMeetings, recordingsFolder, refused, wire } from "./http.ts";
import { deleteMeetingObjects, meetingEngine } from "./jobs.ts";
import { enqueueMeeting } from "./queue.ts";

const job = (c: Context<AppEnv>, meetingId: string) => ({
  meetingId,
  orgId: c.var.member.orgId,
  requestId: c.var.requestId,
});

export const meetings = new Hono<AppEnv>()
  .use(async (c, next) => {
    if (!meetingEngine(c.var.config, c.env)) return apiError(c, "not_found", "not found");
    return next();
  })
  .get("/groups", zValidator("query", meetingsListQuerySchema), async (c) => {
    const { before, limit } = c.req.valid("query");
    const listed = await memberMeetings(c).groups({
      before: before ? new Date(before) : null,
      limit,
    });
    if (listed.status !== "ok") return refused(c, listed);
    return c.json({
      groups: listed.groups.map((g) => ({
        ...g,
        lastStartedAt: g.lastStartedAt?.toISOString() ?? null,
      })),
    });
  })
  .get("/groups/:key", async (c) => {
    const digest = await memberMeetings(c).groupDigest(c.req.param("key"));
    if (digest.status !== "ok") return refused(c, digest);
    return c.json({
      summary: digest.cached?.summary ?? null,
      timeline: digest.meetings.flatMap((m) =>
        m.highlights.map((h) => ({ meetingId: m.id, startedAt: m.startedAt.toISOString(), ...h })),
      ),
      meetings: digest.meetings.map((m) => ({
        id: m.id,
        title: m.title,
        startedAt: m.startedAt.toISOString(),
        summary: m.summary,
      })),
    });
  })
  .get("/search", zValidator("query", meetingsSearchQuerySchema), async (c) => {
    const { q, limit } = c.req.valid("query");
    const found = await memberMeetings(c).search(q, limit);
    if (found.status !== "ok") return refused(c, found);
    return c.json({
      hits: found.hits.map((h) => ({ ...h, startedAt: h.startedAt.toISOString() })),
    });
  })
  .get("/", zValidator("query", meetingsListQuerySchema), async (c) => {
    const { before, limit, group } = c.req.valid("query");
    const listed = await memberMeetings(c).list({
      before: before ? new Date(before) : null,
      limit,
      groupKey: group,
    });
    if (listed.status !== "ok") return refused(c, listed);
    return c.json({ meetings: listed.meetings.map(wire) });
  })
  .post("/", zValidator("json", startMeetingBodySchema), async (c) => {
    const body = c.req.valid("json");
    const room = await hasAllowance(c.var.db, c.var.config, c.var.member.orgId, "meetingMinutes");
    if (!room.ok && room.reason === "plan_required") {
      return apiError(c, "plan_required", "recording meetings needs a paid plan", {
        details: { feature: "meetings" },
      });
    }
    if (!room.ok) {
      return apiError(c, "allowance_reached", "this month's meeting minutes are used up", {
        details: { meter: "meetingMinutes", resetsAt: room.until.toISOString() },
      });
    }
    const folderId = await recordingsFolder(memberFiles(c));
    if (!folderId) return apiError(c, "not_found", "your My files could not be reached");
    const ownDomains = [c.var.user.email.split("@")[1] ?? ""];
    const attendees = body.attendees.map((a) => ({ address: a.address, name: a.name ?? null }));
    const groupKey = body.event?.recurring
      ? groupKeyFor({
          meetingId: "",
          eventUid: body.event.uid,
          recurring: true,
          attendees: [],
          ownDomains,
        })
      : (() => {
          const key = groupKeyFor({
            meetingId: "",
            eventUid: null,
            recurring: false,
            attendees: attendees.map((a) => a.address),
            ownDomains,
          });
          return key.startsWith("meeting:") ? null : key;
        })();
    const started = await memberMeetings(c).start({
      title: body.title ?? null,
      event: body.event
        ? { uid: body.event.uid, recurrenceId: body.event.recurrenceId ?? null }
        : null,
      attendees,
      groupKey,
      consent: body.consent,
    });
    if (started.status === "recording_elsewhere") {
      return c.json(
        {
          status: started.status,
          meetingId: started.meetingId,
          recordedByMemberId: started.recordedByMemberId,
        },
        409,
      );
    }
    if (started.status !== "ok") return refused(c, started);
    return c.json({ meetingId: started.meetingId, part: started.part, folderId }, 201);
  })
  .post("/:id/stop", zValidator("json", stopMeetingBodySchema), async (c) => {
    const id = c.req.param("id");
    const body = c.req.valid("json");
    const meeting = await memberMeetings(c).get(id);
    if (meeting.status !== "ok") return refused(c, meeting);
    if (meeting.meeting.recordedByMemberId !== c.var.member.id)
      return refused(c, { status: "forbidden" });
    const file = await memberFiles(c).file(body.audioNodeId);
    if (
      file.status !== "ok" ||
      file.file.space !== "personal" ||
      file.file.ownerMemberId !== c.var.member.id
    ) {
      return refused(c, { status: "not_a_recording" });
    }
    const stopped = await meetingsPipeline(c.var.db).stopRecording(id, {
      endedAt: new Date(),
      durationMs: body.durationMs,
      audioNodeId: body.audioNodeId,
      micSpans: body.micSpans,
      cuts: body.cuts,
    });
    if (!stopped && meeting.meeting.status !== "uploaded")
      return refused(c, { status: "not_stoppable" });
    await gateMeter(c.var.db, c.var.config, {
      orgId: c.var.member.orgId,
      meter: "meetingMinutes",
      key: body.audioNodeId,
      amount: Math.max(1, Math.ceil(body.durationMs / 60_000)),
      always: true,
    });
    await enqueueMeeting(c.env, { ...job(c, id), step: "transcribe" });
    return c.body(null, 204);
  })
  .post("/:id/retry", async (c) => {
    const id = c.req.param("id");
    const meeting = await memberMeetings(c).get(id);
    if (meeting.status !== "ok") return refused(c, meeting);
    if (meeting.role === "viewer") return refused(c, { status: "forbidden" });
    const restarted = await meetingsPipeline(c.var.db).restartFailed(id);
    if (!restarted) return refused(c, { status: "not_retryable" });
    await enqueueMeeting(c.env, {
      ...job(c, id),
      step: restarted === "naming" ? "name" : "transcribe",
    });
    return c.body(null, 204);
  })
  .get("/:id", async (c) => {
    const found = await memberMeetings(c).get(c.req.param("id"));
    if (found.status !== "ok") return refused(c, found);
    return c.json({ ...found, meeting: wire(found.meeting) });
  })
  .get("/:id/transcript", async (c) => {
    const found = await memberMeetings(c).transcript(c.req.param("id"));
    if (found.status !== "ok") return refused(c, found);
    return c.json({ segments: found.segments });
  })
  .get("/:id/audio", async (c) => {
    const found = await memberMeetings(c).get(c.req.param("id"));
    if (found.status !== "ok") return refused(c, found);
    const nodeId = (await meetingsPipeline(c.var.db).meeting(found.meeting.id))?.meeting
      .audioNodeId;
    const file = nodeId ? await storageWorkspaceFile(c.var.db, c.var.member.orgId, nodeId) : null;
    if (!file) return refused(c, { status: "not_found" });
    return meetingFile(c, file);
  })
  .patch("/:id", zValidator("json", changeMeetingBodySchema), async (c) => {
    const changed = await memberMeetings(c).change(c.req.param("id"), c.req.valid("json"));
    if (changed.status !== "ok") return refused(c, changed);
    return c.body(null, 204);
  })
  .put("/:id/grants/:address", zValidator("json", grantMeetingBodySchema), async (c) => {
    const granted = await memberMeetings(c).grant(
      c.req.param("id"),
      c.req.param("address"),
      c.req.valid("json").role,
    );
    if (granted.status !== "ok") return refused(c, granted);
    return c.json({ address: granted.address }, granted.created ? 201 : 200);
  })
  .delete("/:id/grants/:address", async (c) => {
    const revoked = await memberMeetings(c).revoke(c.req.param("id"), c.req.param("address"));
    if (revoked.status !== "ok") return refused(c, revoked);
    return c.body(null, 204);
  })
  .put("/:id/speakers/:label", zValidator("json", renameSpeakerBodySchema), async (c) => {
    const body = c.req.valid("json");
    const renamed = await memberMeetings(c).renameSpeaker(c.req.param("id"), c.req.param("label"), {
      name: body.name,
      address: body.address ?? null,
    });
    if (renamed.status !== "ok") return refused(c, renamed);
    return c.body(null, 204);
  })
  .post("/actions/:id/:decision{accept|dismiss}", async (c) => {
    const accept = c.req.param("decision") === "accept";
    const taskId = accept ? await taskFor(c, c.req.param("id")) : null;
    const decided = await memberMeetings(c).decideAction(c.req.param("id"), { accept, taskId });
    if (decided.status !== "ok" && taskId) {
      await forMember(c.var.db, c.var.member.id).calendar.deleteTask(taskId);
    }
    if (decided.status !== "ok") return refused(c, decided);
    return c.json({ action: decided.action });
  })
  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    const removed = await memberMeetings(c).remove(id);
    if (removed.status !== "ok") return refused(c, removed);
    await deleteMeetingObjects(c.env, c.var.member.orgId, id);
    const files = memberFiles(c);
    for (const nodeId of removed.files) await files.trash(nodeId);
    return c.body(null, 204);
  });

async function taskFor(c: Context<AppEnv>, actionId: string) {
  const found = await memberMeetings(c).action(actionId);
  if (found.status !== "ok") return null;
  const { action, role, meetingTitle } = found;
  if (action.kind !== "task" || action.state !== "open" || role === "viewer") return null;
  const payload = action.payload as { title?: string; owner?: string | null; due?: string | null };
  const notes = [
    `From the meeting ${meetingTitle ?? "without a title"}`,
    payload.owner ? `Owner: ${payload.owner}` : null,
    payload.due ? `Due: ${payload.due}` : null,
  ].filter(Boolean);
  const made = await forMember(c.var.db, c.var.member.id).calendar.createTask({
    title: payload.title ?? "Task from a meeting",
    body: notes.join("\n"),
  });
  return made.status === "ok" ? made.task.id : null;
}
