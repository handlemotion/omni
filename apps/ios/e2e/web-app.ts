import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { promisify } from "node:util";
import type { Browser, BrowserContext } from "playwright-core";

const appRoot = join(import.meta.dirname, "..");
/** The web export the suite renders; `dist/` is ignored by git. */
export const webDist = join(appRoot, "dist/e2e-web");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/**
 * The app's web export (README: "Check it without a Mac"), with `apiOrigin` baked in as
 * `EXPO_PUBLIC_OMNI_API_URL`. Slow (about 15 s warm): run it once per suite.
 */
export async function exportWebApp(apiOrigin: string) {
  await promisify(execFile)(
    join(appRoot, "node_modules/.bin/expo"),
    ["export", "--platform", "web", "--output-dir", webDist, "--clear"],
    {
      cwd: appRoot,
      env: { ...process.env, EXPO_PUBLIC_OMNI_API_URL: apiOrigin, CI: "1" },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
}

/**
 * One origin for the exported app and the Worker, the way a browser must see them for the app's
 * `credentials: "include"` calls and the session cookie: `/api/*` goes to `workerUrl`, a file
 * from the export is served as is, and any other path gets `index.html` (the router reads it).
 * Listens first, so the origin is known before the export that bakes it in.
 */
export async function serveWebApp() {
  let workerUrl: URL | undefined;
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://app").pathname;
    if (path.startsWith("/api/") && workerUrl) forward(req, res, workerUrl);
    else void serveFile(path, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    proxyTo(url: string | URL) {
      workerUrl = new URL(url);
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function forward(req: IncomingMessage, res: ServerResponse, target: URL) {
  const upstream = request(
    {
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: target.host },
    },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    },
  );
  upstream.on("error", () => res.writeHead(502).end());
  req.pipe(upstream);
}

async function serveFile(path: string, res: ServerResponse) {
  const file = normalize(join(webDist, path));
  const inside = file.startsWith(webDist) && extname(file) !== "";
  const body = inside ? await readFile(file).catch(() => null) : null;
  if (body) {
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
    return;
  }
  res.writeHead(200, { "content-type": TYPES[".html"] });
  res.end(await readFile(join(webDist, "index.html")));
}

function pickWorkspace(workspaceId: string) {
  window.localStorage.setItem("omni_workspace", workspaceId);
}

/** An iPhone-sized page on the app's origin, signed in with `cookie` (from `signIn()`). */
export async function openApp(
  browser: Browser,
  app: { origin: string },
  cookie: string,
  workspaceId: string,
) {
  const context: BrowserContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: app.origin };
    }),
  );
  await context.addInitScript(pickWorkspace, workspaceId);
  return context;
}
