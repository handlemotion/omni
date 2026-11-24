import { sticky } from "./sticky.ts";

const SETTLE_MS = 150;

/** Eases every `position: sticky` in the app, the ones later screens mount included. */
export function easeStickies() {
  const all = sticky.all();
  let timer: number | undefined;

  new MutationObserver(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(all.scan, SETTLE_MS);
  }).observe(document.body, { childList: true, subtree: true });
}
