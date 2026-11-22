import { type Context, Hono } from "hono";
import type { AppEnv } from "../context.ts";

const INSTALLERS: Record<string, { key: string; fallbackName: string; type: string }> = {
  macos: {
    key: "download/macos.dmg",
    fallbackName: "Omni.dmg",
    type: "application/x-apple-diskimage",
  },
  windows: {
    key: "download/windows.exe",
    fallbackName: "Omni-Setup.exe",
    type: "application/vnd.microsoft.portable-executable",
  },
};

const RELEASE_FILE = /^[0-9A-Za-z.+-]+\/[0-9A-Za-z._-]+$/;

function serve(object: R2ObjectBody, type: string, cache: string, fallbackName?: string) {
  const headers = new Headers({
    "content-type": type,
    "content-length": String(object.size),
    "cache-control": cache,
    etag: object.httpEtag,
  });
  const stored = object.httpMetadata?.contentDisposition;
  if (fallbackName)
    headers.set("content-disposition", stored ?? `attachment; filename="${fallbackName}"`);
  return new Response(object.body, { headers });
}

async function feed(c: Context<AppEnv>, key: string) {
  const object = await c.env.DESKTOP_BUCKET.get(key);
  if (!object) return c.notFound();
  return serve(object, "application/json", "public, max-age=60");
}

export const desktop = new Hono<AppEnv>()
  .get("/latest.json", (c) => feed(c, "latest.json"))
  .get("/windows/latest.json", (c) => feed(c, "windows/latest.json"))
  .get("/download/:platform", async (c) => {
    const installer = INSTALLERS[c.req.param("platform")];
    const object = installer ? await c.env.DESKTOP_BUCKET.get(installer.key) : null;
    if (!installer || !object) return c.notFound();
    return serve(object, installer.type, "public, max-age=300", installer.fallbackName);
  })
  .get("/releases/*", async (c) => {
    const path = c.req.path.slice("/desktop/releases/".length);
    if (!RELEASE_FILE.test(path) || path.includes("..")) return c.notFound();
    const object = await c.env.DESKTOP_BUCKET.get(`releases/${path}`);
    if (!object) return c.notFound();
    return serve(object, "application/octet-stream", "public, max-age=31536000, immutable");
  });
