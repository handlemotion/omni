import { onlineManager } from "@tanstack/react-query";

const PROBE_MIN_MS = 1_000;
const PROBE_MAX_MS = 15_000;

let browserOnline = typeof navigator === "undefined" ? true : navigator.onLine;
let answering = true;
let probing = false;
let publish: ((online: boolean) => void) | undefined;
const wakeListeners = new Set<() => void>();

const update = () => publish?.(browserOnline && answering);
const probeNeeded = () => !answering && browserOnline;

function wake() {
  for (const listener of wakeListeners) listener();
}

function onNetworkChange() {
  browserOnline = navigator.onLine;
  update();
  if (!browserOnline) return;
  wake();
  void probe();
}

function onVisible() {
  if (document.visibilityState === "visible") wake();
}

onlineManager.setEventListener((setOnline) => {
  publish = setOnline;
  window.addEventListener("online", onNetworkChange);
  window.addEventListener("offline", onNetworkChange);
  document.addEventListener("visibilitychange", onVisible);
  update();
  return () => {
    window.removeEventListener("online", onNetworkChange);
    window.removeEventListener("offline", onNetworkChange);
    document.removeEventListener("visibilitychange", onVisible);
  };
});

/**
 * Runs `listener` when the connection may have come back (browser online, tab visible again, the
 * API answering again, a request just failed): the realtime socket uses it to reconnect without
 * waiting out its backoff.
 */
export function onWake(listener: () => void) {
  wakeListeners.add(listener);
  return () => void wakeListeners.delete(listener);
}

/** A request got no answer: offline until something answers. */
export function reportNoAnswer() {
  if (!answering) return;
  answering = false;
  update();
  wake();
  void probe();
}

/** The API answered (any status): it is reachable, so the socket need not wait out its backoff. */
export function reportAnswer() {
  if (answering) return;
  answering = true;
  update();
  wake();
}

/** Asks the API now instead of waiting out the probe's backoff (the offline notice's Try again). */
export async function retryNow() {
  if (!probeNeeded()) return;
  if (await workerAnswers()) reportAnswer();
}

async function probe() {
  if (probing) return;
  probing = true;
  try {
    for (let delay = PROBE_MIN_MS; probeNeeded(); delay = Math.min(PROBE_MAX_MS, delay * 2)) {
      await new Promise((resolve) => setTimeout(resolve, delay / 2 + (Math.random() * delay) / 2));
      if (probeNeeded() && (await workerAnswers())) reportAnswer();
    }
  } finally {
    probing = false;
  }
}

async function workerAnswers() {
  try {
    const response = await fetch("/api/me", { cache: "no-store" });
    return response.status < 500;
  } catch {
    return false;
  }
}
