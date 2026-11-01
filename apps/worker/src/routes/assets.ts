// What sanitized mail HTML loads: remote images through the proxy, inline (cid:) images and
// attachments by content hash, and the HTML document itself. All need a signed-in member; mail
// objects are served only when `forMember` (or its member-scoped helpers) can see them.
import { zValidator } from "@hono/zod-validator";
import { findMemberAttachmentByHash, forMember } from "@omni/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { imageHeaders, isProxiableImageType, proxyImage } from "../image-proxy.ts";

function notFound(): never {
  throw new HTTPException(404, { message: "not found" });
}

/**
 * Streams a stored attachment. Raster images may render inline (they back cid: images); every
 * other type downloads, so nothing a sender attached ever runs on our origin.
 */
export function attachmentResponse(
  object: R2ObjectBody,
  file: { filename: string; mimeType: string },
) {
  const inline = isProxiableImageType(file.mimeType);
  return new Response(object.body, {
    headers: {
      ...imageHeaders(inline ? file.mimeType : "application/octet-stream"),
      "content-length": String(object.size),
      "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      "cache-control": "private, max-age=3600",
    },
  });
}

export const assets = new Hono<AppEnv>()
  .get(
    "/image-proxy",
    zValidator("query", z.object({ url: z.string().min(1).max(4096) })),
    async (c) => {
      const result = await proxyImage(c.req.valid("query").url, {
        dohUrl: c.var.config.IMAGE_PROXY_DOH_URL,
        testAllowOrigin: c.var.config.IMAGE_PROXY_TEST_ALLOW_ORIGIN,
      });
      if (result instanceof Response) return result;
      return c.json({ error: result.reason }, result.status);
    },
  )

  .get("/attachments/:sha256{[0-9a-f]{64}}", async (c) => {
    const file = await findMemberAttachmentByHash(c.var.db, c.var.member.id, c.req.param("sha256"));
    if (!file) notFound();
    const object = await c.env.MAIL_BUCKET.get(file.r2Key);
    if (!object) notFound();
    return attachmentResponse(object, file);
  })

  /** The sanitized HTML of one message, for a sandboxed iframe. No script can run in it. */
  .get("/threads/:id/messages/:messageId/html", async (c) => {
    const thread = await forMember(c.var.db, c.var.member.id).getThread(c.req.param("id"));
    const message = thread?.messages.find((m) => m.id === c.req.param("messageId"));
    if (!message?.htmlR2Key) notFound();
    const object = await c.env.MAIL_BUCKET.get(message.htmlR2Key);
    if (!object) notFound();
    const frameAncestors = ["'self'", ...c.var.config.auth.trustedOrigins].join(" ");
    return new Response(object.body, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        // Images only from our proxy and attachments; inline styles are the sanitizer's output.
        "content-security-policy": `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors ${frameAncestors}; sandbox allow-popups allow-popups-to-escape-sandbox`,
        "cache-control": "private, max-age=3600",
      },
    });
  });
