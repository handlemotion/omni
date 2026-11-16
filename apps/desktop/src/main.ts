// The bundled local shell (docs/spec/desktop.md, "The shell"). It decides which Omni server the
// window shows, then hands over to Rust (`open_server`), which keeps the choice, grants that
// origin the remote capability and loads it: the stored choice, else the build's default, else
// the server picker. A server that does not answer gets the offline screen. It never calls
// `/api`; the one request it makes is a no-cors probe of the server's root.
import { invoke } from "@tauri-apps/api/core";

const PROBE_TIMEOUT_MS = 8000;

const picker = document.querySelector<HTMLFormElement>("#picker")!;
const offline = document.querySelector<HTMLFormElement>("#offline")!;
const input = picker.querySelector<HTMLInputElement>("input")!;

/** True when the server answers at all. An opaque response is enough: it is reachable. */
async function reachable(origin: string): Promise<boolean> {
  try {
    await fetch(new URL("/", origin), {
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

async function open(origin: string, from: HTMLFormElement): Promise<boolean> {
  busy(from, true);
  const ok =
    (await reachable(origin)) &&
    (await invoke("open_server", { origin }).then(
      () => true,
      () => false,
    ));
  busy(from, false);
  return ok;
}

function showOffline(origin: string) {
  document.querySelector("#offline-host")!.textContent = new URL(origin).host;
  offline.dataset.origin = origin;
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
  const origin = offline.dataset.origin;
  if (origin && !(await open(origin, offline))) showOffline(origin);
});

document.querySelector("#change")!.addEventListener("click", () => {
  input.value = offline.dataset.origin ? new URL(offline.dataset.origin).host : "";
  show(picker);
});

// Coming back online retries by itself, so a laptop waking up needs no click.
window.addEventListener("online", () => {
  if (!offline.hidden) offline.requestSubmit();
});

async function start() {
  // `?pick` comes from the app menu's "Change Server…": always ask.
  if (new URLSearchParams(window.location.search).has("pick")) return show(picker);
  const stored = await invoke<string | null>("server_origin");
  const origin = toOrigin(stored ?? import.meta.env.OMNI_DESKTOP_ORIGIN ?? "");
  if (origin === null) return show(picker);
  if (!(await open(origin, offline))) showOffline(origin);
}

void start();
