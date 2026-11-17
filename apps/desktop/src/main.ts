// The bundled local shell (docs/spec/desktop.md, "The shell"). It decides which Omni server the
// window shows, then hands over to Rust (`open_server`), which keeps the choice, grants that
// origin the remote capability and loads it: the stored choice, else the build's default, else
// the server picker. A server that does not answer gets the offline screen. It never calls
// `/api`; the one request it makes is a no-cors probe of the server's root. Until it knows what to
// show, and while the server's page loads after, it shows the loading screen.
//
// `?resume=<path>` comes from Rust when the window's page died (`recovery.rs`): reopen that page
// once the server answers. `?offline` is the same after too many in a row: wait for a click.
import { invoke } from "@tauri-apps/api/core";

const PROBE_TIMEOUT_MS = 8000;

const picker = document.querySelector<HTMLFormElement>("#picker")!;
const offline = document.querySelector<HTMLFormElement>("#offline")!;
const input = picker.querySelector<HTMLInputElement>("input")!;
const loading = document.querySelector<HTMLElement>("#loading")!;
const params = new URLSearchParams(window.location.search);

/** True when the server answers at all. An opaque response is enough: it is reachable. */
async function reachable(origin: string): Promise<boolean> {
  try {
    // HEAD: an answer is all it needs, not the page.
    await fetch(new URL("/", origin), {
      method: "HEAD",
      mode: "no-cors",
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return true;
  } catch {
    return false;
  }
}

/** The address as Rust will store it, or null when it is not one (Rust checks again). */
function toOrigin(value: string): string | null {
  const text = value.trim();
  try {
    const url = new URL(text.includes("://") ? text : `https://${text}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function show(form: HTMLFormElement) {
  loading.hidden = true;
  picker.hidden = form !== picker;
  offline.hidden = form !== offline;
  form.querySelector<HTMLElement>("input, button")?.focus();
}

function busy(form: HTMLFormElement, on: boolean) {
  for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
    "input, button",
  )) {
    control.disabled = on;
  }
}

async function open(origin: string, from: HTMLFormElement, path?: string): Promise<boolean> {
  busy(from, true);
  const ok =
    (await reachable(origin)) &&
    (await invoke("open_server", { origin, path }).then(
      () => true,
      () => false,
    ));
  busy(from, false);
  return ok;
}

function showOffline(origin: string, path?: string) {
  document.querySelector("#offline-host")!.textContent = new URL(origin).host;
  offline.dataset.origin = origin;
  if (path) offline.dataset.path = path;
  show(offline);
}

picker.addEventListener("submit", async (event) => {
  event.preventDefault();
  const origin = toOrigin(input.value);
  const ok = origin !== null && (await open(origin, picker));
  input.setAttribute("aria-invalid", String(!ok));
  if (!ok) input.focus();
});

offline.addEventListener("submit", async (event) => {
  event.preventDefault();
  const { origin, path } = offline.dataset;
  if (origin && !(await open(origin, offline, path))) showOffline(origin, path);
});

document.querySelector("#change")!.addEventListener("click", () => {
  input.value = offline.dataset.origin ? new URL(offline.dataset.origin).origin : "";
  show(picker);
});

// Coming back online retries by itself, so a laptop waking up needs no click.
window.addEventListener("online", () => {
  if (!offline.hidden) offline.requestSubmit();
});

async function start() {
  // `?pick` comes from the app menu's "Change Server…": always ask.
  if (params.has("pick")) return show(picker);
  const stored = await invoke<string | null>("server_origin");
  const origin = toOrigin(stored ?? import.meta.env.OMNI_DESKTOP_ORIGIN ?? "");
  if (origin === null) return show(picker);
  const path = params.get("resume") ?? undefined;
  if (params.has("offline")) return showOffline(origin);
  if (!(await open(origin, offline, path))) showOffline(origin, path);
}

void start();
