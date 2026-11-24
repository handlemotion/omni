import type {
  DesktopRecording,
  StopMeetingBody,
  StorageNodeResponse,
  StorageUpload,
  StorageUploadResponse,
} from "@omni/contracts";
import { toApiError } from "@omni/contracts/errors";
import type { InferResponseType } from "hono/client";
import type { Api } from "./api.ts";
import { failure, send, type RecordingTransport } from "./recording-transport.ts";

export { RecordingUploadError, type RecordingTransport } from "./recording-transport.ts";

type Meeting = InferResponseType<Api["meetings"][":id"]["$get"], 200>["meeting"];

/** A spool's two files: the audio, always, and the video, when the person picked a window. */
export type RecordingFile = "audio" | "video";

export interface RecordingProgress {
  uploadId?: string;
  nodeId?: string;
  videoUploadId?: string;
  videoNodeId?: string;
}

/** Where a recording's bytes are and where its progress is kept: the desktop shell's spool. */
export interface RecordingSpool {
  /** Part `partNumber` (from 1) of `file`, in Drive's parts of `partSize` bytes. */
  readPart(
    id: string,
    partNumber: number,
    partSize: number,
    file: RecordingFile,
  ): Promise<Uint8Array>;
  /** Keeps how far the uploads got, so a restart carries on instead of opening a second one. */
  mark(id: string, progress: RecordingProgress): Promise<void>;
  /** Deletes the spool, once the meeting has its file. */
  discard(id: string): Promise<void>;
}

/**
 * `finished`: the meeting has its audio and its pipeline started. `meeting_gone`: the meeting was
 * deleted while its recording waited here; the file stays in the recorder's Drive.
 */
export type FinishOutcome = "finished" | "meeting_gone";

function request(transport: RecordingTransport) {
  return (method: string, path: string, body?: unknown) => {
    if (body === undefined) return send(transport, method, path);
    if (body instanceof Uint8Array) {
      return send(transport, method, path, {
        body: new Blob([new Uint8Array(body)]),
        headers: { "content-type": "application/octet-stream" },
      });
    }
    return send(transport, method, path, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The file's name in `Recordings`: the meeting's title and when it started, in local time; the
 * video takes the audio's name with `.mp4`.
 */
export function recordingFileName(
  recording: Pick<DesktopRecording, "title" | "startedAtMs">,
  file: RecordingFile = "audio",
) {
  const at = new Date(recording.startedAtMs);
  const when = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}.${pad(at.getMinutes())}`;
  const title = (recording.title ?? "").replace(/[/\\:]+/g, " ").trim() || "Meeting";
  return `${title.slice(0, 200)} ${when}.${file === "video" ? "mp4" : "ogg"}`;
}

/** The recordings this member should finish: theirs, and stopped. Others wait for their owner. */
export const recordingsToFinish = (recordings: DesktopRecording[], memberId: string) =>
  recordings.filter((r) => r.memberId === memberId && r.state === "stopped");

type Call = ReturnType<typeof request>;

async function fileTheExpiredUploadBecame(call: Call, uploadId: string, size: number) {
  const found = await call("GET", `/storage/nodes/${uploadId}`);
  if (found.status === 404) return null;
  if (!found.ok) throw failure(found, "reading the uploaded file");
  const { node } = found.json as StorageNodeResponse;
  return node.size === size ? node.id : null;
}

interface Upload {
  file: RecordingFile;
  size: number;
  uploadId: string | null | undefined;
}

const MIME: Record<RecordingFile, string> = { audio: "audio/ogg", video: "video/mp4" };

async function openUpload(
  call: Call,
  spool: RecordingSpool,
  recording: DesktopRecording,
  one: Upload,
) {
  if (one.uploadId) {
    const found = await call("GET", `/storage/uploads/${one.uploadId}`);
    const upload = found.ok ? (found.json as StorageUploadResponse).upload : null;
    if (upload && upload.size === one.size) return { kind: "upload" as const, upload };
    if (!found.ok && found.status !== 404) throw failure(found, "reading the upload");
    const nodeId = await fileTheExpiredUploadBecame(call, one.uploadId, one.size);
    if (nodeId) return { kind: "file" as const, nodeId };
  }
  const opened = await call("POST", "/storage/uploads", {
    name: recordingFileName(recording, one.file),
    size: one.size,
    mimeType: MIME[one.file],
    parentId: recording.folderId,
  });
  if (!opened.ok) throw failure(opened, "opening the upload");
  const { upload } = opened.json as StorageUploadResponse;
  await spool.mark(
    recording.id,
    one.file === "video" ? { videoUploadId: upload.id } : { uploadId: upload.id },
  );
  return { kind: "upload" as const, upload };
}

async function sendParts(
  call: Call,
  spool: RecordingSpool,
  id: string,
  file: RecordingFile,
  upload: StorageUpload,
) {
  const stored = new Set(upload.parts.map((p) => p.partNumber));
  for (let n = 1; n <= upload.partCount; n++) {
    if (stored.has(n)) continue;
    const bytes = await spool.readPart(id, n, upload.partSize, file);
    const sent = await call("PUT", `/storage/uploads/${upload.id}/parts/${n}`, bytes);
    if (!sent.ok) throw failure(sent, `sending part ${n}`);
  }
}

async function uploadFile(
  call: Call,
  spool: RecordingSpool,
  recording: DesktopRecording,
  one: Upload,
) {
  const opened = await openUpload(call, spool, recording, one);
  if (opened.kind === "file") return opened.nodeId;
  let { upload } = opened;
  if (upload.nodeId) return upload.nodeId;
  for (let attempt = 0; ; attempt++) {
    await sendParts(call, spool, recording.id, one.file, upload);
    const done = await call("POST", `/storage/uploads/${upload.id}/complete`);
    if (done.ok) return (done.json as StorageNodeResponse).node.id;
    const bucketForgotTheParts = toApiError(done.json, "").code === "upload_incomplete";
    if (!bucketForgotTheParts || attempt > 0) {
      throw failure(done, "completing the upload");
    }
    const again = await call("GET", `/storage/uploads/${upload.id}`);
    if (!again.ok) throw failure(again, "reading the upload");
    upload = (again.json as StorageUploadResponse).upload;
  }
}

async function meetingAlreadyPastStop(call: Call, meetingId: string) {
  const found = await call("GET", `/meetings/${meetingId}`);
  if (!found.ok) return false;
  const { meeting } = found.json as { meeting: Meeting };
  return meeting.status !== "recording" && meeting.hasAudio;
}

async function uploadVideo(call: Call, spool: RecordingSpool, recording: DesktopRecording) {
  if (recording.videoNodeId) return recording.videoNodeId;
  if (!recording.videoSize) return undefined;
  const one = {
    file: "video" as const,
    size: recording.videoSize,
    uploadId: recording.videoUploadId,
  };
  const nodeId = await uploadFile(call, spool, recording, one);
  await spool.mark(recording.id, { videoNodeId: nodeId });
  return nodeId;
}

/**
 * Finishes a stopped recording: uploads its audio, then its video when it has one, through
 * Drive's resumable upload into the recorder's `Recordings` folder, tells the meeting (`POST /api/meetings/:id/stop`) and deletes
 * the spool. Every step is safe to run again, and progress is kept in the spool as it goes, so
 * an app killed at any point finishes the same upload, into the same file, when it next runs
 * this. A failure throws `RecordingUploadError` and keeps the spool.
 */
export async function finishRecording(
  transport: RecordingTransport,
  spool: RecordingSpool,
  recording: DesktopRecording,
) {
  if (recording.state !== "stopped")
    throw new Error("finishRecording: the recording is still going");
  const call = request(transport);
  const audio = { file: "audio" as const, size: recording.size, uploadId: recording.uploadId };
  const nodeId = recording.nodeId ?? (await uploadFile(call, spool, recording, audio));
  if (!recording.nodeId) await spool.mark(recording.id, { nodeId });
  const videoNodeId = await uploadVideo(call, spool, recording);
  const stop: StopMeetingBody = {
    audioNodeId: nodeId,
    ...(videoNodeId ? { videoNodeId } : {}),
    durationMs: recording.durationMs,
    micSpans: recording.micSpans,
    cuts: recording.cuts,
  };
  const stopped = await call("POST", `/meetings/${recording.meetingId}/stop`, stop);
  if (
    !stopped.ok &&
    stopped.status !== 404 &&
    !(await meetingAlreadyPastStop(call, recording.meetingId))
  ) {
    throw failure(stopped, "stopping the meeting");
  }
  await spool.discard(recording.id);
  const outcome: FinishOutcome = stopped.status === 404 ? "meeting_gone" : "finished";
  return outcome;
}
