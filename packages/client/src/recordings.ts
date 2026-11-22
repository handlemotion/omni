import type {
  DesktopRecording,
  StopMeetingBody,
  StorageNodeResponse,
  StorageUpload,
  StorageUploadResponse,
} from "@omni/contracts";
import {
  ERROR_FORMAT_HEADER,
  ERROR_FORMAT_VERSION,
  toApiError,
  type ApiErrorInfo,
} from "@omni/contracts/errors";

/** A failed call while finishing a recording; the spool is kept, so finishing again resumes. */
export class RecordingUploadError extends Error {
  readonly status: number;
  readonly info: ApiErrorInfo;

  constructor(status: number, info: ApiErrorInfo) {
    super(info.message);
    this.name = "RecordingUploadError";
    this.status = status;
    this.info = info;
  }
}

/** Where a recording's bytes are and where its progress is kept: the desktop shell's spool. */
export interface RecordingSpool {
  /** Part `partNumber` (from 1) of the file, in Drive's parts of `partSize` bytes. */
  readPart(id: string, partNumber: number, partSize: number): Promise<Uint8Array>;
  /** Keeps how far the upload got, so a restart carries on instead of opening a second one. */
  mark(id: string, progress: { uploadId?: string; nodeId?: string }): Promise<void>;
  /** Deletes the spool, once the meeting has its file. */
  discard(id: string): Promise<void>;
}

export interface RecordingTransport {
  /** The Worker's origin. */
  baseUrl: string;
  fetch?: typeof fetch;
  /** Headers for every request (iOS: the session cookie). */
  headers?: Record<string, string>;
}

/**
 * `finished`: the meeting has its audio and its pipeline started. `meeting_gone`: the meeting was
 * deleted while its recording waited here; the file stays in the recorder's Drive.
 */
export type FinishOutcome = "finished" | "meeting_gone";

function request(transport: RecordingTransport) {
  const send = transport.fetch ?? fetch;
  return async (method: string, path: string, body?: unknown) => {
    const raw = body instanceof Uint8Array;
    const response = await send(new URL(`/api${path}`, transport.baseUrl), {
      method,
      credentials: "include",
      headers: {
        [ERROR_FORMAT_HEADER]: ERROR_FORMAT_VERSION,
        ...(body === undefined
          ? {}
          : { "content-type": raw ? "application/octet-stream" : "application/json" }),
        ...transport.headers,
      },
      body: raw
        ? new Blob([new Uint8Array(body)])
        : body === undefined
          ? undefined
          : JSON.stringify(body),
    });
    const text = await response.text();
    const json: unknown = text ? JSON.parse(text) : null;
    return { status: response.status, ok: response.ok, json };
  };
}

const fail = (answer: { status: number; json: unknown }, what: string) =>
  new RecordingUploadError(
    answer.status,
    toApiError(answer.json, `${what} failed (${answer.status})`),
  );

const pad = (n: number) => String(n).padStart(2, "0");

/** The file's name in `Recordings`: the meeting's title and when it started, in local time. */
export function recordingFileName(recording: Pick<DesktopRecording, "title" | "startedAtMs">) {
  const at = new Date(recording.startedAtMs);
  const when = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}.${pad(at.getMinutes())}`;
  const title = (recording.title ?? "").replace(/[/\\:]+/g, " ").trim() || "Meeting";
  return `${title.slice(0, 200)} ${when}.ogg`;
}

/** The recordings this member should finish: theirs, and stopped. Others wait for their owner. */
export const recordingsToFinish = (recordings: DesktopRecording[], memberId: string) =>
  recordings.filter((r) => r.memberId === memberId && r.state === "stopped");

type Call = ReturnType<typeof request>;

async function fileTheExpiredUploadBecame(call: Call, uploadId: string, size: number) {
  const found = await call("GET", `/storage/nodes/${uploadId}`);
  if (found.status === 404) return null;
  if (!found.ok) throw fail(found, "reading the uploaded file");
  const { node } = found.json as StorageNodeResponse;
  return node.size === size ? node.id : null;
}

async function openUpload(call: Call, spool: RecordingSpool, recording: DesktopRecording) {
  if (recording.uploadId) {
    const found = await call("GET", `/storage/uploads/${recording.uploadId}`);
    const upload = found.ok ? (found.json as StorageUploadResponse).upload : null;
    if (upload && upload.size === recording.size) return { kind: "upload" as const, upload };
    if (!found.ok && found.status !== 404) throw fail(found, "reading the upload");
    const nodeId = await fileTheExpiredUploadBecame(call, recording.uploadId, recording.size);
    if (nodeId) return { kind: "file" as const, nodeId };
  }
  const opened = await call("POST", "/storage/uploads", {
    name: recordingFileName(recording),
    size: recording.size,
    mimeType: "audio/ogg",
    parentId: recording.folderId,
  });
  if (!opened.ok) throw fail(opened, "opening the upload");
  const { upload } = opened.json as StorageUploadResponse;
  await spool.mark(recording.id, { uploadId: upload.id });
  return { kind: "upload" as const, upload };
}

async function sendParts(call: Call, spool: RecordingSpool, id: string, upload: StorageUpload) {
  const stored = new Set(upload.parts.map((p) => p.partNumber));
  for (let n = 1; n <= upload.partCount; n++) {
    if (stored.has(n)) continue;
    const bytes = await spool.readPart(id, n, upload.partSize);
    const sent = await call("PUT", `/storage/uploads/${upload.id}/parts/${n}`, bytes);
    if (!sent.ok) throw fail(sent, `sending part ${n}`);
  }
}

async function uploadFile(call: Call, spool: RecordingSpool, recording: DesktopRecording) {
  const opened = await openUpload(call, spool, recording);
  if (opened.kind === "file") return opened.nodeId;
  let { upload } = opened;
  if (upload.nodeId) return upload.nodeId;
  for (let attempt = 0; ; attempt++) {
    await sendParts(call, spool, recording.id, upload);
    const done = await call("POST", `/storage/uploads/${upload.id}/complete`);
    if (done.ok) return (done.json as StorageNodeResponse).node.id;
    const bucketForgotTheParts = toApiError(done.json, "").code === "upload_incomplete";
    if (!bucketForgotTheParts || attempt > 0) {
      throw fail(done, "completing the upload");
    }
    const again = await call("GET", `/storage/uploads/${upload.id}`);
    if (!again.ok) throw fail(again, "reading the upload");
    upload = (again.json as StorageUploadResponse).upload;
  }
}

async function meetingAlreadyPastStop(call: Call, meetingId: string) {
  const found = await call("GET", `/meetings/${meetingId}`);
  if (!found.ok) return false;
  const { meeting } = found.json as { meeting: { status: string; hasAudio: boolean } };
  return meeting.status !== "recording" && meeting.hasAudio;
}

/**
 * Finishes a stopped recording: uploads its file through Drive's resumable upload into the
 * recorder's `Recordings` folder, tells the meeting (`POST /api/meetings/:id/stop`) and deletes
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
  const nodeId = recording.nodeId ?? (await uploadFile(call, spool, recording));
  if (!recording.nodeId) await spool.mark(recording.id, { nodeId });
  const stop: StopMeetingBody = {
    audioNodeId: nodeId,
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
    throw fail(stopped, "stopping the meeting");
  }
  await spool.discard(recording.id);
  const outcome: FinishOutcome = stopped.status === 404 ? "meeting_gone" : "finished";
  return outcome;
}
