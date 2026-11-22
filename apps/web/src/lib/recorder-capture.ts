/** How often `MediaRecorder` hands over a chunk: the most a crash can lose. */
export const CHUNK_MS = 5000;
const TICK_MS = 100;
const SPEECH_RMS = 0.02;
const SPAN_GAP_MS = 400;
const MAX_SPANS = 20_000;

export interface CaptureResult {
  chunks: number;
  durationMs: number;
  micSpans: Array<{ startMs: number; endMs: number }>;
}

export interface Capture {
  /** The microphone's level, 0 to 1, for the pill's meter. */
  level(): number;
  /** Stops recording; resolves once the last chunk has been handed to `onChunk` and kept. */
  stop(): Promise<CaptureResult>;
}

/** Why recording could not start, for the person: they shared no tab sound, or refused. */
export class CaptureRefused extends Error {}

export const canCapture = () =>
  typeof navigator !== "undefined" &&
  typeof navigator.mediaDevices?.getDisplayMedia === "function" &&
  typeof MediaRecorder !== "undefined" &&
  MediaRecorder.isTypeSupported("audio/webm;codecs=opus");

function rms(analyser: AnalyserNode, buffer: Float32Array<ArrayBuffer>) {
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (const v of buffer) sum += v * v;
  return Math.sqrt(sum / buffer.length);
}

function micSpans(mic: AnalyserNode, tab: AnalyserNode, clock: () => number) {
  const spans: CaptureResult["micSpans"] = [];
  const micBuffer = new Float32Array(mic.fftSize);
  const tabBuffer = new Float32Array(tab.fftSize);
  let level = 0;
  const timer = setInterval(() => {
    const m = rms(mic, micBuffer);
    const t = rms(tab, tabBuffer);
    level = Math.min(1, m * 8);
    if (m < SPEECH_RMS || m < t * 1.5) return;
    const now = clock();
    const last = spans.at(-1);
    if (last && now - last.endMs <= SPAN_GAP_MS) last.endMs = now;
    else if (spans.length < MAX_SPANS) spans.push({ startMs: now, endMs: now + TICK_MS });
  }, TICK_MS);
  return { spans, level: () => level, stop: () => clearInterval(timer) };
}

async function tabAudio() {
  const display = await navigator.mediaDevices
    .getDisplayMedia({ video: true, audio: true })
    .catch(() => {
      throw new CaptureRefused("no tab was shared");
    });
  for (const track of display.getVideoTracks()) track.stop();
  if (!display.getAudioTracks().length) {
    for (const track of display.getTracks()) track.stop();
    throw new CaptureRefused("the shared tab has no sound");
  }
  return display;
}

/**
 * Records the shared tab's sound and the microphone as two channels (mic left, tab right) in
 * Opus, handing over a chunk every `CHUNK_MS` to `onChunk`, one at a time and in order. Ends by
 * itself (`onEnded`) when the person stops sharing the tab, or when a chunk could not be kept:
 * the recording then ends at the last chunk kept, so it never has a gap.
 */
export async function startCapture(
  onChunk: (seq: number, endMs: number, blob: Blob) => Promise<void>,
  onEnded: () => void,
) {
  const display = await tabAudio();
  const mic = await navigator.mediaDevices
    .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    .catch(() => {
      for (const track of display.getTracks()) track.stop();
      throw new CaptureRefused("the microphone was not allowed");
    });
  const context = new AudioContext();
  const micSource = context.createMediaStreamSource(mic);
  const tabSource = context.createMediaStreamSource(display);
  const merger = context.createChannelMerger(2);
  micSource.connect(merger, 0, 0);
  tabSource.connect(merger, 0, 1);
  const out = context.createMediaStreamDestination();
  out.channelCount = 2;
  merger.connect(out);
  const micAnalyser = context.createAnalyser();
  const tabAnalyser = context.createAnalyser();
  micSource.connect(micAnalyser);
  tabSource.connect(tabAnalyser);

  const started = performance.now();
  const clock = () => Math.round(performance.now() - started);
  const speech = micSpans(micAnalyser, tabAnalyser, clock);
  const recorder = new MediaRecorder(out.stream, {
    mimeType: "audio/webm;codecs=opus",
    audioBitsPerSecond: 48_000,
  });
  let seq = 0;
  let keptCount = 0;
  let broken = false;
  let kept = Promise.resolve();
  recorder.ondataavailable = (event) => {
    if (!event.data.size || broken) return;
    const n = seq++;
    const endMs = clock();
    kept = kept.then(async () => {
      if (broken) return;
      try {
        await onChunk(n, endMs, event.data);
        keptCount = n + 1;
      } catch {
        broken = true;
        onEnded();
      }
    });
  };
  const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
  for (const track of display.getAudioTracks()) track.addEventListener("ended", onEnded);
  recorder.start(CHUNK_MS);

  return {
    level: speech.level,
    async stop() {
      if (recorder.state !== "inactive") recorder.stop();
      await stopped;
      await kept;
      speech.stop();
      for (const track of [...display.getTracks(), ...mic.getTracks()]) track.stop();
      await context.close();
      return { chunks: keptCount, durationMs: clock(), micSpans: speech.spans };
    },
  } satisfies Capture;
}
