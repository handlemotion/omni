import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DesktopRecording } from "@omni/contracts";

const QUIET_DB = -60;

const main = document.querySelector("main");
const time = document.querySelector("time");
const level = document.querySelector<HTMLElement>(".level span");
const pause = document.querySelector<HTMLButtonElement>(".pause");
const stop = document.querySelector<HTMLButtonElement>(".stop");

function clock(ms: number) {
  const seconds = Math.floor(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function render(recording: DesktopRecording) {
  if (!main || !time || !level || !pause) return;
  main.dataset.state = recording.state;
  time.textContent = clock(recording.durationMs);
  const loudness = Math.min(1, Math.max(0, (recording.micDb - QUIET_DB) / -QUIET_DB));
  level.style.width = `${Math.round(loudness * 100)}%`;
  pause.setAttribute("aria-label", recording.state === "paused" ? "Resume" : "Pause");
}

pause?.addEventListener("click", () => {
  const paused = main?.dataset.state === "paused";
  void invoke(paused ? "recording_resume" : "recording_pause");
});
stop?.addEventListener("click", () => {
  if (stop) stop.disabled = true;
  void invoke("recording_stop").finally(() => {
    if (stop) stop.disabled = false;
  });
});

void listen<DesktopRecording>("recording-changed", (event) => render(event.payload));
