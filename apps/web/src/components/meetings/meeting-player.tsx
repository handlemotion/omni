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

interface Player {
  timeMs: number;
  durationMs: number;
  playing: boolean;
  seek: (ms: number) => void;
  toggle: () => void;
  rate: number;
  setRate: (rate: number) => void;
  hasAudio: boolean;
}

const NO_PLAYER: Player = {
  timeMs: 0,
  durationMs: 0,
  playing: false,
  seek: () => {},
  toggle: () => {},
  rate: 1,
  setRate: () => {},
  hasAudio: false,
};

const PlayerContext = createContext<Player>(NO_PLAYER);

/** The meeting's recording, one per page, for the player row and the transcript to share. */
export function MeetingAudio(props: {
  id: string;
  hasAudio: boolean;
  durationMs: number | null;
  children: ReactNode;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const [timeMs, setTimeMs] = useState(0);
  const [durationMs, setDurationMs] = useState(props.durationMs ?? 0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRateState] = useState(1);
  const setRate = useCallback((next: number) => {
    if (audio.current) audio.current.playbackRate = next;
    setRateState(next);
  }, []);
  const seek = useCallback((ms: number) => {
    const element = audio.current;
    if (!element) return;
    element.currentTime = ms / 1000;
    setTimeMs(ms);
    void element.play();
  }, []);
  const toggle = useCallback(() => {
    const element = audio.current;
    if (!element) return;
    if (element.paused) void element.play();
    else element.pause();
  }, []);
  const player = useMemo(
    () => ({ timeMs, durationMs, playing, seek, toggle, rate, setRate, hasAudio: props.hasAudio }),
    [timeMs, durationMs, playing, seek, toggle, rate, setRate, props.hasAudio],
  );
  return (
    <PlayerContext.Provider value={player}>
      {props.hasAudio && (
        // oxlint-disable-next-line jsx-a11y/media-has-caption
        <audio
          ref={audio}
          src={meetingAudioUrl(props.id)}
          preload="metadata"
          onTimeUpdate={(event) => setTimeMs(event.currentTarget.currentTime * 1000)}
          onLoadedMetadata={(event) => {
            const seconds = event.currentTarget.duration;
            if (Number.isFinite(seconds)) setDurationMs(seconds * 1000);
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          className="hidden"
        />
      )}
      {props.children}
    </PlayerContext.Provider>
  );
}

export const usePlayer = () => useContext(PlayerContext);
