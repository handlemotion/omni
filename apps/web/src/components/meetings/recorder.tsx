import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { IconMicrophone, IconStop } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RecorderContext, useRecorder, useRecorderState } from "@/hooks/use-recorder.ts";
import { useMember } from "@/hooks/use-session.ts";
import { useMeetingsEnabled } from "@/hooks/use-meetings.ts";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";
import { desktop } from "@/lib/desktop.ts";
import { meetingPath } from "@/lib/meetings.ts";
import { canCapture } from "@/lib/recorder-capture.ts";

/**
 * The browser recorder for the whole app: one recording at a time, the pill while it runs, and
 * the recordings a reload or a crash left on this computer sent in the background. Off in the
 * desktop app, which records with its own recorder.
 */
export function RecorderProvider({ children }: { children: ReactNode }) {
  const enabled = useMeetingsEnabled() && !desktop.isDesktop && canCapture();
  if (!enabled) return children;
  return <EnabledRecorder>{children}</EnabledRecorder>;
}

function EnabledRecorder({ children }: { children: ReactNode }) {
  const { member } = useMember();
  const recorder = useRecorderState(member.id);
  return (
    <RecorderContext value={recorder}>
      {children}
      <RecorderPill />
    </RecorderContext>
  );
}

/** Record, in the Meetings sidebar; it asks once that everyone was told before it starts. */
export function RecordButton() {
  const recorder = useRecorder();
  const [asking, setAsking] = useState(false);
  if (!recorder) return null;
  const busy = recorder.phase !== "idle";
  return (
    <>
      <Button
        intent="secondary"
        size="sm"
        className="w-full"
        isDisabled={busy}
        isPending={recorder.phase === "starting"}
        onPress={() => setAsking(true)}
      >
        <IconMicrophone />
        Record
      </Button>
      <Dialog role="alertdialog" isOpen={asking} onOpenChange={setAsking} closeButton={false}>
        <DialogHeader>
          <DialogTitle>Everyone in this meeting knows it is being recorded.</DialogTitle>
        </DialogHeader>
        <DialogFooter>
          <Button intent="outline" onPress={() => setAsking(false)}>
            Cancel
          </Button>
          <Button
            onPress={() => {
              setAsking(false);
              void recorder.start();
            }}
          >
            Record
          </Button>
        </DialogFooter>
      </Dialog>
    </>
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
