import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { meetingAudioUrl } from "@/lib/meetings.ts";

const DRIFT_SECONDS = 0.25;

interface Player {
  timeMs: number;
  durationMs: number;
  playing: boolean;
  seek: (ms: number) => void;
  toggle: () => void;
  rate: number;
  setRate: (rate: number) => void;
  video: (element: HTMLVideoElement | null) => void;
  hasAudio: boolean;
  hasVideo: boolean;
}

const NO_PLAYER: Player = {
  timeMs: 0,
  durationMs: 0,
  playing: false,
  seek: () => {},
  toggle: () => {},
  rate: 1,
  setRate: () => {},
  video: () => {},
  hasAudio: false,
  hasVideo: false,
};

function follow(video: HTMLVideoElement | null, audio: HTMLAudioElement | null) {
  if (!video || !audio) return;
  if (video.playbackRate !== audio.playbackRate) video.playbackRate = audio.playbackRate;
  const end = Number.isFinite(video.duration) ? video.duration : Infinity;
  const at = Math.min(audio.currentTime, end);
  if (Math.abs(video.currentTime - at) > DRIFT_SECONDS) video.currentTime = at;
  if (audio.paused && !video.paused) video.pause();
  if (!audio.paused && video.paused && at < end) void video.play().catch(() => {});
}

const PlayerContext = createContext<Player>(NO_PLAYER);

/** The meeting's recording, one per page, for the player row and the transcript to share. */
export function MeetingAudio(props: {
  id: string;
  hasAudio: boolean;
  hasVideo?: boolean;
  durationMs: number | null;
  children: ReactNode;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const videoElement = useRef<HTMLVideoElement | null>(null);
  const sync = useCallback(() => follow(videoElement.current, audio.current), []);
  const video = useCallback(
    (element: HTMLVideoElement | null) => {
      videoElement.current = element;
      sync();
    },
    [sync],
  );
  const [rate, setRateState] = useState(1);
  const setRate = useCallback(
    (next: number) => {
      if (audio.current) audio.current.playbackRate = next;
      setRateState(next);
      sync();
    },
    [sync],
  );
  const [timeMs, setTimeMs] = useState(0);
  const [durationMs, setDurationMs] = useState(props.durationMs ?? 0);
  const [playing, setPlaying] = useState(false);
  const seek = useCallback(
    (ms: number) => {
      const element = audio.current;
      if (!element) return;
      element.currentTime = ms / 1000;
      setTimeMs(ms);
      sync();
      void element.play();
    },
    [sync],
  );
  const toggle = useCallback(() => {
    const element = audio.current;
    if (!element) return;
    if (element.paused) void element.play();
    else element.pause();
  }, []);
  const hasVideo = props.hasAudio && Boolean(props.hasVideo);
  const player = useMemo(
    () => ({
      timeMs,
      durationMs,
      playing,
      seek,
      toggle,
      rate,
      setRate,
      video,
      hasAudio: props.hasAudio,
      hasVideo,
    }),
    [timeMs, durationMs, playing, seek, toggle, rate, setRate, video, props.hasAudio, hasVideo],
  );
  return (
    <PlayerContext.Provider value={player}>
      {props.hasAudio && (
        // oxlint-disable-next-line jsx-a11y/media-has-caption
        <audio
          ref={audio}
          src={meetingAudioUrl(props.id)}
          preload="metadata"
          onTimeUpdate={(event) => {
            setTimeMs(event.currentTarget.currentTime * 1000);
            sync();
          }}
          onSeeked={sync}
          onWaiting={() => videoElement.current?.pause()}
          onPlaying={sync}
          onLoadedMetadata={(event) => {
            const seconds = event.currentTarget.duration;
            if (Number.isFinite(seconds)) setDurationMs(seconds * 1000);
          }}
          onPlay={() => {
            setPlaying(true);
            sync();
          }}
          onPause={() => {
            setPlaying(false);
            sync();
          }}
          className="hidden"
        />
      )}
      {props.children}
    </PlayerContext.Provider>
  );
}

export const usePlayer = () => useContext(PlayerContext);
