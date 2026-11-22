import { forMember, meetingsPipeline, type MemberStorage } from "@omni/db";
import { chunkKey, chunksPrefix } from "./chunks.ts";
import { recordingsFolder } from "./http.ts";
import { MeetingStepFailed, type MeetingRun } from "./jobs.ts";

interface Filing {
  meeting: {
    id: string;
    orgId: string;
    title: string | null;
    startedAt: Date;
    recordedByMemberId: string | null;
  };
  job: { uploadId: string | null; chunkCount: number | null };
}

type Chunks = Awaited<ReturnType<ReturnType<typeof meetingsPipeline>["chunks"]>>;

async function joinChunks(
  run: MeetingRun,
  orgId: string,
  meetingId: string,
  chunks: Chunks,
  key: string,
) {
  const size = chunks.reduce((sum, c) => sum + c.size, 0);
  const { readable, writable } = new FixedLengthStream(size);
  const put = run.env.STORAGE_BUCKET.put(key, readable);
  const write = (async () => {
    for (const chunk of chunks) {
      const object = await run.env.STORAGE_BUCKET.get(
        chunkKey(orgId, meetingId, chunk.seq, chunk.sha256),
      );
      if (!object) {
        await writable.abort();
        throw new MeetingStepFailed(`chunk ${chunk.seq} of the recording is missing`);
      }
      await object.body.pipeTo(writable, { preventClose: true });
    }
    await writable.close();
  })();
  const [written] = await Promise.all([put, write]);
  if (!written) throw new Error("the recording could not be written");
  return { etag: written.etag, size };
}

async function openUpload(files: MemberStorage, found: Filing, size: number) {
  const folderId = await recordingsFolder(files);
  if (!folderId) throw new Error("the recorder's My files could not be reached");
  const day = found.meeting.startedAt.toISOString().slice(0, 10);
  const opened = await files.openUpload(
    { parentId: folderId },
    {
      name: `${found.meeting.title?.trim() || "Recording"} ${day}.webm`,
      size,
      mimeType: "audio/webm",
      limitBytes: null,
    },
  );
  if (opened.status !== "ok") {
    throw new MeetingStepFailed(`Drive did not take the recording (${opened.status})`);
  }
  return opened.upload;
}

async function uploadOf(run: MeetingRun, files: MemberStorage, found: Filing, size: number) {
  const pipeline = meetingsPipeline(run.db);
  const { id } = found.meeting;
  if (found.job.uploadId) {
    const held = await files.upload(found.job.uploadId);
    if (held) return held;
    await pipeline.dropUpload(id, found.job.uploadId);
  }
  const opened = await openUpload(files, found, size);
  if (await pipeline.claimUpload(id, opened.id)) return opened;
  await files.abortUpload(opened.id);
  const other = (await pipeline.meeting(id))?.job.uploadId;
  const held = other ? await files.upload(other) : null;
  if (!held) throw new Error("another delivery is filing the recording");
  return held;
}

/**
 * Files a recording that came as chunks into the recorder's private `Recordings` folder as one
 * Drive file, then lets the chunks go. Safe to run twice: the upload is claimed on the meeting,
 * joining the chunks writes the same bytes, and completing a completed upload answers its file.
 * Null when the meeting was deleted meanwhile (the file goes to the recorder's Trash).
 */
export async function fileRecording(run: MeetingRun, found: Filing) {
  const { meeting } = found;
  const pipeline = meetingsPipeline(run.db);
  if (!meeting.recordedByMemberId) {
    throw new MeetingStepFailed("the recorder left the workspace before the recording was saved");
  }
  const chunks = await pipeline.chunks(meeting.id, found.job.chunkCount);
  if (chunks.length === 0) throw new MeetingStepFailed("no audio arrived");
  const files = forMember(run.db, meeting.recordedByMemberId).storage;
  const size = chunks.reduce((sum, c) => sum + c.size, 0);
  const upload = await uploadOf(run, files, found, size);
  let nodeId = upload.nodeId;
  if (!nodeId) {
    const written = await joinChunks(run, meeting.orgId, meeting.id, chunks, upload.r2Key);
    await files.recordUploadPart(upload.id, { partNumber: 1, ...written });
    const done = await files.completeUpload(upload.id, { limitBytes: null });
    if (done.status !== "ok") {
      throw new MeetingStepFailed(`Drive did not take the recording (${done.status})`);
    }
    nodeId = done.node.id;
  }
  const set = await pipeline.setAudio(meeting.id, nodeId);
  if (set === "gone") {
    await files.trash(nodeId);
    return null;
  }
  await deleteChunks(run.env, meeting.orgId, meeting.id);
  return nodeId;
}

async function deleteChunks(env: Env, orgId: string, meetingId: string) {
  let cursor: string | undefined;
  do {
    const listed = await env.STORAGE_BUCKET.list({
      prefix: chunksPrefix(orgId, meetingId),
      cursor,
    });
    if (listed.objects.length) await env.STORAGE_BUCKET.delete(listed.objects.map((o) => o.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}
