import { useRef, useState } from "react";
import { IconPlayFilled } from "@/components/icons/central";
import type { StorageNode } from "@/lib/storage.ts";
import { useSeen } from "../file-card.tsx";
import { FileGlyph } from "../file-glyph.tsx";

/** "0:44", "12:05", "1:02:33": a clip's length as players show it. */
export function formatDuration(seconds: number) {
  const whole = Math.max(0, Math.round(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

const still = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A video's card: its frame at a tenth of a second (the very first is often black), a play
 * button in the middle and its length in the corner. Resting the pointer on it plays it, muted,
 * from the start. Only its metadata and first frame load until then.
 */
export function VideoArt(props: { node: StorageNode; url: string }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const near = useSeen(anchor);
  const [shown, setShown] = useState(false);
  const [broken, setBroken] = useState(false);
  const [playing, setPlaying] = useState(false);
  const play = () => {
    const element = video.current;
    if (!element || !shown || still()) return;
    element.currentTime = 0;
    void element.play().then(
      () => setPlaying(true),
      () => {},
    );
  };
  const stop = () => {
    const element = video.current;
    setPlaying(false);
    if (!element) return;
    element.pause();
    element.currentTime = 0.1;
  };
  return (
    <div
      className="absolute inset-0 flex items-center justify-center"
      onPointerEnter={play}
      onPointerLeave={stop}
    >
      <span ref={anchor} aria-hidden className="absolute inset-0" />
      {!shown && <FileGlyph kind="video" className="size-8 text-muted-foreground" />}
      {near && !broken && (
        <video
          ref={video}
          src={`${props.url}#t=0.1`}
          aria-hidden
          muted
          loop
          playsInline
          disablePictureInPicture
          preload="metadata"
          tabIndex={-1}
          onLoadedData={() => setShown(true)}
          onError={() => setBroken(true)}
          className={`absolute inset-0 size-full bg-foreground object-cover transition-opacity duration-200 ease-out motion-reduce:transition-none ${shown ? "opacity-100" : "opacity-0"}`}
        />
      )}
      {shown && (
        <>
          <span
            aria-hidden
            className={`absolute inset-0 bg-foreground/25 transition-opacity duration-200 ease-out motion-reduce:transition-none ${playing ? "opacity-0" : "opacity-100"}`}
          />
          <IconPlayFilled
            aria-hidden
            className={`relative size-10 text-background drop-shadow-sm transition-[opacity,scale] duration-200 ease-out motion-reduce:transition-none ${playing ? "scale-90 opacity-0" : "opacity-100"}`}
          />
        </>
      )}
    </div>
  );
}

const BARS = 28;

function bars(seed: string) {
  let h = 2166136261;
  for (const char of seed) h = Math.imul(h ^ char.charCodeAt(0), 16777619);
  return Array.from({ length: BARS }, (_, i) => {
    h = Math.imul(h ^ (h >>> 15), 2246822507) ^ i;
    const noise = ((h >>> 0) % 1000) / 1000;
    const swell = Math.sin((i / (BARS - 1)) * Math.PI);
    return 18 + Math.round((0.35 + 0.65 * swell) * noise * 64);
  });
}

/**
 * A sound file's card: a waveform of bars, drawn rather than decoded (decoding reads the whole
 * file), and its length once its metadata is in.
 */
export function AudioArt(props: { node: StorageNode; url: string }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const near = useSeen(anchor);
  const [duration, setDuration] = useState<number | null>(null);
  return (
    <>
      <span ref={anchor} aria-hidden className="absolute inset-0" />
      <span aria-hidden className="flex h-2/5 w-3/4 items-center justify-between">
        {bars(props.node.name).map((height, i) => (
          <span
            key={i}
            style={{ height: `${height}%` }}
            className="w-[2.5%] rounded-full bg-muted-foreground/45 transition-[scale] duration-300 ease-out group-hover:scale-y-110 motion-reduce:transition-none"
          />
        ))}
      </span>
      {near && (
        // oxlint-disable-next-line jsx-a11y/media-has-caption
        <audio
          src={props.url}
          preload="metadata"
          onLoadedMetadata={(event) => {
            const length = event.currentTarget.duration;
            if (Number.isFinite(length)) setDuration(length);
          }}
        />
      )}
      {duration !== null && (
        <span className="absolute end-3.5 bottom-2.5 text-xs text-muted-foreground tabular-nums">
          {formatDuration(duration)}
        </span>
      )}
    </>
  );
}
