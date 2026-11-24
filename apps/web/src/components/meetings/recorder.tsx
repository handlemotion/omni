import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { IconMicrophone, IconStop } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { DesktopRecordingRequest } from "@omni/client";
import { useDesktopRecorderState } from "@/hooks/use-desktop-recorder.ts";
import { RecorderContext, useRecorder, useRecorderState } from "@/hooks/use-recorder.ts";
import { useMember } from "@/hooks/use-session.ts";
import { useMeetingsEnabled } from "@/hooks/use-meetings.ts";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";
import { desktop } from "@/lib/desktop.ts";
import { meetingPath } from "@/lib/meetings.ts";
import { canCapture } from "@/lib/recorder-capture.ts";

/**
 * The recorder for the whole app: one recording at a time and the consent question before it.
 * In a browser that can share a tab's sound it records here, with the pill, and sends the
 * recordings a reload or a crash left in the background; in the desktop app the shell captures
 * and shows its own pill, and this page uploads what it recorded.
 */
export function RecorderProvider({ children }: { children: ReactNode }) {
  const meetings = useMeetingsEnabled();
  if (meetings && desktop.isDesktop) return <DesktopRecorder>{children}</DesktopRecorder>;
  if (!meetings || !canCapture()) return children;
  return <BrowserRecorder>{children}</BrowserRecorder>;
}

type Pending = { event: DesktopRecordingRequest["event"] } | null;

function BrowserRecorder({ children }: { children: ReactNode }) {
  const { member } = useMember();
  const recorder = useRecorderState(member.id);
  const [asking, setAsking] = useState(false);
  return (
    <RecorderContext value={{ ...recorder, ask: () => setAsking(true) }}>
      {children}
      <Consent
        isOpen={asking}
        onCancel={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false);
          void recorder.start();
        }}
      />
      <RecorderPill />
    </RecorderContext>
  );
}

function DesktopRecorder({ children }: { children: ReactNode }) {
  const { member } = useMember();
  const [pending, setPending] = useState<Pending>(null);
  const recorder = useDesktopRecorderState(member.id, (event) => setPending({ event }));
  return (
    <RecorderContext value={{ ...recorder, ask: () => setPending({ event: null }) }}>
      {children}
      <Consent
        isOpen={pending !== null && recorder.phase === "idle"}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          const event = pending?.event ?? null;
          setPending(null);
          void recorder.start(event);
        }}
      />
    </RecorderContext>
  );
}

function Consent(props: { isOpen: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Dialog
      role="alertdialog"
      isOpen={props.isOpen}
      onOpenChange={(open) => !open && props.onCancel()}
      closeButton={false}
    >
      <DialogHeader>
        <DialogTitle>Everyone in this meeting knows it is being recorded.</DialogTitle>
      </DialogHeader>
      <DialogFooter>
        <Button intent="outline" onPress={props.onCancel}>
          Cancel
        </Button>
        <Button onPress={props.onConfirm}>Record</Button>
      </DialogFooter>
    </Dialog>
  );
}

/** Record, in the Meetings sidebar; it asks once that everyone was told before it starts. */
export function RecordButton() {
  const recorder = useRecorder();
  if (!recorder) return null;
  if (desktop.isDesktop && recorder.phase === "recording") {
    return (
      <Button intent="outline" size="sm" className="w-full" onPress={() => void recorder.stop()}>
        <IconStop />
        Stop
      </Button>
    );
  }
  return (
    <Button
      intent="primary"
      size="sm"
      className="w-full"
      isDisabled={recorder.phase !== "idle"}
      isPending={recorder.phase === "starting" || recorder.phase === "stopping"}
      onPress={recorder.ask}
    >
      <IconMicrophone />
      Record
    </Button>
  );
}

const clock = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
};

function useElapsed(startedAt: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt ? now - startedAt : 0;
}

function RecorderPill() {
  const recorder = useRecorder();
  const navigate = useNavigate();
  const { href } = useWorkspacePaths();
  const elapsed = useElapsed(recorder?.startedAt ?? null);
  if (!recorder || (recorder.phase !== "recording" && recorder.phase !== "stopping")) {
    return recorder?.offline ? <OfflineDot /> : null;
  }
  const meetingId = recorder.meetingId;
  const stop = async () => {
    await recorder.stop();
    if (meetingId) await navigate({ href: href(meetingPath(meetingId)) });
  };
  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full border border-border bg-overlay py-1.5 ps-4 pe-1.5 text-overlay-foreground shadow-(--shadow-overlay)"
    >
      <span
        aria-hidden
        className={
          recorder.offline
            ? "size-2 rounded-full bg-muted-foreground"
            : "size-2 rounded-full bg-danger"
        }
      />
      <span className="text-sm tabular-nums">{clock(elapsed)}</span>
      {recorder.offline && <span className="text-sm text-muted-foreground">Offline</span>}
      <Button
        intent="secondary"
        size="sm"
        isPending={recorder.phase === "stopping"}
        onPress={() => void stop()}
      >
        <IconStop />
        Stop
      </Button>
    </div>
  );
}

function OfflineDot() {
  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-overlay px-4 py-2 text-overlay-foreground shadow-(--shadow-overlay)"
    >
      <span aria-hidden className="size-2 rounded-full bg-muted-foreground" />
      <span className="text-sm text-muted-foreground">Offline</span>
    </div>
  );
}
