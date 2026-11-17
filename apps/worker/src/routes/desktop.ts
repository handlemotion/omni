import { Hono } from "hono";
import type { AppEnv } from "../context.ts";

const INSTALLERS: Record<string, { key: string; filename: string; type: string }> = {
  macos: { key: "download/macos.dmg", filename: "Omni.dmg", type: "application/x-apple-diskimage" },
};

const RELEASE_FILE = /^[0-9A-Za-z.+-]+\/[0-9A-Za-z._-]+$/;

function serve(object: R2ObjectBody, type: string, cache: string, filename?: string) {
  const headers = new Headers({
    "content-type": type,
    "content-length": String(object.size),
    "cache-control": cache,
    etag: object.httpEtag,
  });
  if (filename) headers.set("content-disposition", `attachment; filename="${filename}"`);
  return new Response(object.body, { headers });
}

export const desktop = new Hono<AppEnv>()
  .get("/latest.json", async (c) => {
    const object = await c.env.DESKTOP_BUCKET.get("latest.json");
    if (!object) return c.notFound();
    return serve(object, "application/json", "public, max-age=60");
  })
  .get("/download/:platform", async (c) => {
    const installer = INSTALLERS[c.req.param("platform")];
    const object = installer ? await c.env.DESKTOP_BUCKET.get(installer.key) : null;
    if (!installer || !object) return c.notFound();
    return serve(object, installer.type, "public, max-age=300", installer.filename);
  })
  .get("/releases/*", async (c) => {
    const path = c.req.path.slice("/desktop/releases/".length);
    if (!RELEASE_FILE.test(path) || path.includes("..")) return c.notFound();
    const object = await c.env.DESKTOP_BUCKET.get(`releases/${path}`);
    if (!object) return c.notFound();
    return serve(object, "application/octet-stream", "public, max-age=31536000, immutable");
  });
