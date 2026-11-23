import type { UploadNetwork } from "@omni/client";

const offline = () => typeof navigator !== "undefined" && !navigator.onLine;

function online(signal: AbortSignal) {
  if (!offline()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const back = () => {
      signal.removeEventListener("abort", quit);
      resolve();
    };
    const quit = () => {
      window.removeEventListener("online", back);
      reject(signal.reason ?? new DOMException("upload cancelled", "AbortError"));
    };
    window.addEventListener("online", back, { once: true });
    signal.addEventListener("abort", quit, { once: true });
  });
}

/** The browser's network, as `navigator.onLine` and its `online` event tell it. */
export const browserNetwork: UploadNetwork = { online, offline };
