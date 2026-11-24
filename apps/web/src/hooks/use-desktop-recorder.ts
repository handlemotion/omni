import {
  ApiError,
  finishRecording,
  recordingsToFinish,
  type DesktopRecorderError,
  type DesktopRecording,
  type DesktopRecordingRequest,
  type RecordingTransport,
} from "@omni/client";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { appToast } from "@/components/ui/toast";
import type { Recorder, RecorderState } from "@/hooks/use-recorder.ts";
import { api, call } from "@/lib/api.ts";
import { workspaceHeaders } from "@/lib/current-workspace.ts";
import { meetingKeys } from "@/lib/meetings.ts";

type Bridge = typeof import("@/lib/desktop-bridge.ts");
type Event = NonNullable<DesktopRecordingRequest["event"]>;

const bridge = () => import("@/lib/desktop-bridge.ts");

const IDLE: RecorderState = {
  phase: "idle",
  meetingId: null,
  startedAt: null,
  waiting: 0,
  offline: false,
};

const transport = () =>
  ({ baseUrl: window.location.origin, headers: workspaceHeaders() }) satisfies RecordingTransport;

const isRecorderError = (error: unknown): error is DesktopRecorderError =>
  typeof error === "object" && error !== null && "code" in error && "message" in error;

function startFailed(error: unknown) {
  if (isRecorderError(error) && error.code === "permission_denied") {
    appToast.error("Omni needs microphone and audio recording access");
  } else {
    if (!isRecorderError(error)) console.error("recorder: start failed", error);
    appToast.error("Recording did not start");
  }
}

async function openMeeting(event: Event | null) {
  try {
    const opened = await call(
      api.meetings.$post({
        json: {
          attendees: [],
          consent: true,
          title: event?.title ?? null,
          event: event ? { id: event.id, recurrenceId: event.recurrenceId ?? null } : "now",
        },
      }),
    );
    if (!("folderId" in opened)) return null;
    return opened;
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 0;
    appToast.error(
      status === 402
        ? "Recording needs minutes left on your plan"
        : status === 409
          ? "Someone is already recording this meeting"
          : "Recording did not start",
    );
    return null;
  }
}

const live = (r: DesktopRecording) => r.state !== "stopped";

const RETRY_FIRST_MS = 2_000;
const RETRY_MAX_MS = 5 * 60_000;

function waitOrOnline(ms: number) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener("online", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    window.addEventListener("online", done);
  });
}

function useFinisher(memberId: string, b: Bridge | null) {
  const client = useQueryClient();
  const running = useRef(new Set<string>());
  const finish = useCallback(
    (recordings: DesktopRecording[]) => {
      if (!b) return;
      for (const recording of recordingsToFinish(recordings, memberId)) {
        if (running.current.has(recording.id)) continue;
        running.current.add(recording.id);
        void (async () => {
          for (let wait = RETRY_FIRST_MS; ; wait = Math.min(wait * 2, RETRY_MAX_MS)) {
            const current = (await b.recordingList().catch(() => [recording])).find(
              (r) => r.id === recording.id,
            );
            if (!current) return;
            try {
              await finishRecording(transport(), b.recordingSpool, current);
              await client.invalidateQueries({ queryKey: meetingKeys.all() });
              return;
            } catch (error) {
              console.error("recorder: upload failed", error);
              if (wait === RETRY_FIRST_MS) {
                appToast.error("The recording could not be sent yet; it stays on this computer");
              }
              await waitOrOnline(wait);
            }
          }
        })().finally(() => running.current.delete(recording.id));
      }
    },
    [b, client, memberId],
  );
  return finish;
}

/**
 * The desktop app's recorder: the shell captures, spools and shows the pill; this page holds the
 * session, so it opens the meeting, starts the shell's capture and, once it stops, uploads the
 * spool with `finishRecording`. Recordings a crash or a quit left are finished at load.
 * `docs/spec/meetings.md`, "The shell's part".
 */
export function useDesktopRecorderState(
  memberId: string,
  onRequested: (event: Event | null) => void,
) {
  const [state, setState] = useState<RecorderState>(IDLE);
  const [b, setBridge] = useState<Bridge | null>(null);
  const micDb = useRef(-120);
  const finish = useFinisher(memberId, b);
  const requested = useRef(onRequested);
  requested.current = onRequested;

  useEffect(() => {
    void bridge().then(setBridge);
  }, []);

  useEffect(() => {
    if (!b) return;
    const show = (recording: DesktopRecording | undefined) => {
      micDb.current = recording?.micDb ?? -120;
      setState((now) =>
        recording && live(recording)
          ? {
              ...IDLE,
              phase: now.phase === "stopping" ? "stopping" : "recording",
              meetingId: recording.meetingId,
              startedAt: recording.startedAtMs,
            }
          : now.phase === "starting"
            ? now
            : IDLE,
      );
    };
    const changed = b.onRecordingChanged((recording) => {
      show(live(recording) ? recording : undefined);
      if (!live(recording)) finish([recording]);
    });
    const asked = b.onRecordingRequested((request) => requested.current(request.event ?? null));
    const offered = b.onRecordingOffered((request) => requested.current(request.event ?? null));
    void b
      .recordingList()
      .then((all) => {
        show(all.find(live));
        finish(all);
      })
      .catch((error: unknown) => console.warn("recorder: listing failed", error));
    return () => {
      for (const stop of [changed, asked, offered]) void stop.then((unlisten) => unlisten());
    };
  }, [b, finish]);

  const start = useCallback(
    async (event: Event | null = null) => {
      if (!b) return;
      setState({ ...IDLE, phase: "starting" });
      const opened = await openMeeting(event);
      if (!opened) return setState(IDLE);
      try {
        const recording = await b.recordingStart({
          meetingId: opened.meetingId,
          memberId,
          folderId: opened.folderId,
          title: event?.title ?? null,
        });
        setState({
          ...IDLE,
          phase: "recording",
          meetingId: recording.meetingId,
          startedAt: recording.startedAtMs,
        });
      } catch (error) {
        await call(api.meetings[":id"].$delete({ param: { id: opened.meetingId } })).catch(
          () => {},
        );
        startFailed(error);
        setState(IDLE);
      }
    },
    [b, memberId],
  );

  const stop = useCallback(async () => {
    if (!b) return;
    setState((s) => ({ ...s, phase: "stopping" }));
    try {
      await b.recordingStop();
    } finally {
      setState(IDLE);
    }
  }, [b]);

  return {
    ...state,
    start,
    stop,
    level: () => Math.max(0, Math.min(1, (micDb.current + 60) / 60)),
  } satisfies Recorder;
}
