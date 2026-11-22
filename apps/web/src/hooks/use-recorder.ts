import {
  drainRecording,
  OFFLINE_AFTER_MS,
  type RecordingTransport,
  type SendingState,
} from "@omni/client";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { appToast } from "@/components/ui/toast";
import { ApiError, api, call } from "@/lib/api.ts";
import { workspaceHeaders } from "@/lib/current-workspace.ts";
import { meetingKeys } from "@/lib/meetings.ts";
import { CaptureRefused, startCapture, type Capture } from "@/lib/recorder-capture.ts";
import {
  browserSpool,
  heldRecordings,
  keepChunk,
  keepRecording,
  keepStop,
  lastChunk,
} from "@/lib/recorder-spool.ts";

export type RecorderPhase = "idle" | "starting" | "recording" | "stopping";

export interface RecorderState {
  phase: RecorderPhase;
  meetingId: string | null;
  startedAt: number | null;
  /** Chunks on this computer the server has not acknowledged yet, across recordings. */
  waiting: number;
  /** Nothing has gone through for `OFFLINE_AFTER_MS` while chunks wait. */
  offline: boolean;
}

export interface Recorder extends RecorderState {
  start(): Promise<void>;
  stop(): Promise<void>;
  level(): number;
}

const IDLE: RecorderState = {
  phase: "idle",
  meetingId: null,
  startedAt: null,
  waiting: 0,
  offline: false,
};

export const RecorderContext = createContext<Recorder | null>(null);

/** The browser recorder, from `RecorderProvider`; null outside it. */
export const useRecorder = () => useContext(RecorderContext);

const transport = () =>
  ({
    baseUrl: window.location.origin,
    headers: workspaceHeaders(),
  }) satisfies RecordingTransport;

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

const lockName = (meetingId: string) => `omni-recorder:${meetingId}`;

async function holdRecording(meetingId: string) {
  if (!navigator.locks) return () => {};
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await new Promise<void>((acquired) => {
    void navigator.locks.request(lockName(meetingId), () => {
      acquired();
      return held;
    });
  });
  return release;
}

function unlessHeld(meetingId: string, act: () => Promise<boolean>) {
  if (!navigator.locks) return act();
  return navigator.locks.request(lockName(meetingId), { ifAvailable: true }, (lock) =>
    lock ? act() : false,
  );
}

async function stopLeftBehind(meetingId: string) {
  const last = await lastChunk(meetingId);
  if (!last) {
    await browserSpool.discard(meetingId);
    return false;
  }
  await keepStop(meetingId, { chunks: last.seq + 1, durationMs: last.endMs, micSpans: null });
  return true;
}

function useDrains(onState: (meetingId: string, state: SendingState) => void) {
  const client = useQueryClient();
  const running = useRef(new Set<string>());
  return useCallback(
    (meetingId: string) => {
      if (running.current.has(meetingId)) return;
      running.current.add(meetingId);
      void drainRecording(transport(), browserSpool, meetingId, {
        wait: waitOrOnline,
        onState: (state) => onState(meetingId, state),
      })
        .then(() => client.invalidateQueries({ queryKey: meetingKeys.all() }))
        .catch(() => appToast.error("The recording could not be sent; it stays on this computer"))
        .finally(() => {
          running.current.delete(meetingId);
          onState(meetingId, { waiting: 0, lastAckAt: Date.now(), failing: null });
        });
    },
    [client, onState],
  );
}

function useSendingStates() {
  const [states, setStates] = useState(new Map<string, SendingState>());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const onState = useCallback((meetingId: string, state: SendingState) => {
    setStates((all) => new Map(all).set(meetingId, state));
  }, []);
  const all = [...states.values()];
  const waiting = all.reduce((sum, s) => sum + s.waiting, 0);
  const offline = all.some((s) => s.waiting > 0 && now - s.lastAckAt > OFFLINE_AFTER_MS);
  return { onState, waiting, offline };
}

async function openMeeting() {
  try {
    return await call(api.meetings.$post({ json: { attendees: [], consent: true } }));
  } catch (error) {
    const plan = error instanceof ApiError && error.status === 402;
    appToast.error(plan ? "Recording needs minutes left on your plan" : "Recording did not start");
    return null;
  }
}

/**
 * The browser recorder's state: one recording at a time, sent as it records, and every
 * recording this computer still holds for `memberId` finished in the background, which is how a
 * reload or a crash resumes. `docs/spec/meetings.md`, "The browser recorder".
 */
export function useRecorderState(memberId: string) {
  const [state, setState] = useState<RecorderState>(IDLE);
  const capture = useRef<Capture | null>(null);
  const active = useRef<{ meetingId: string; release: () => void } | null>(null);
  const sending = useSendingStates();
  const drain = useDrains(sending.onState);

  useEffect(() => {
    void heldRecordings(memberId).then(async (held) => {
      for (const recording of held) {
        const { meetingId } = recording;
        if (meetingId === active.current?.meetingId) continue;
        const finishing = await unlessHeld(meetingId, async () =>
          recording.stop ? true : stopLeftBehind(meetingId),
        );
        if (finishing) drain(meetingId);
      }
    });
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- once per member, at load
  }, [memberId, drain]);

  const finish = useCallback(async () => {
    const running = capture.current;
    const held = active.current;
    if (!running || !held) return;
    capture.current = null;
    active.current = null;
    try {
      await keepStop(held.meetingId, await running.stop());
    } finally {
      held.release();
    }
  }, []);

  const stop = useCallback(async () => {
    if (!capture.current) return;
    setState((s) => ({ ...s, phase: "stopping" }));
    await finish();
    setState(IDLE);
  }, [finish]);

  useEffect(() => () => void finish(), [finish]);

  const start = useCallback(async () => {
    if (capture.current) return;
    setState({ ...IDLE, phase: "starting" });
    const opened = await openMeeting();
    if (!opened) return setState(IDLE);
    const { meetingId } = opened;
    const release = await holdRecording(meetingId);
    active.current = { meetingId, release };
    await keepRecording({ meetingId, memberId, startedAt: Date.now(), stop: null });
    try {
      capture.current = await startCapture(
        (seq, endMs, blob) => keepChunk(meetingId, seq, endMs, blob),
        () => void stopRef.current(),
      );
    } catch (error) {
      active.current = null;
      release();
      await browserSpool.discard(meetingId);
      await call(api.meetings[":id"].$delete({ param: { id: meetingId } })).catch(() => {});
      if (!(error instanceof CaptureRefused)) console.error("recorder: capture failed", error);
      appToast.error("Recording did not start");
      return setState(IDLE);
    }
    setState({ ...IDLE, phase: "recording", meetingId, startedAt: Date.now() });
    drain(meetingId);
  }, [drain, memberId]);

  const stopRef = useRef(stop);
  stopRef.current = stop;

  return {
    ...state,
    waiting: sending.waiting,
    offline: sending.offline,
    start,
    stop,
    level: () => capture.current?.level() ?? 0,
  } satisfies Recorder;
}
