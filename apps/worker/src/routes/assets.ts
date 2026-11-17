import { findMemberAttachmentByHash, findMemberMessageHtml } from "@omni/db";
import { codeForStatus } from "@omni/contracts";
import { domainLogoSource, logoSource } from "@omni/mail-core/sender-logo";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { apiError } from "../errors.ts";
import { imageHeaders, isProxiableImageType, proxyImage } from "../image-proxy.ts";
import { checkRateLimit, tooManyRequests } from "../rate-limiter.ts";
import { senderLogo } from "../sender-logo.ts";
import { zValidator } from "../validator.ts";

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
      const { config, member } = c.var;
      const result = await proxyImage(c.req.valid("query").url, {
        dohUrl: config.IMAGE_PROXY_DOH_URL,
        testAllowOrigin: config.IMAGE_PROXY_TEST_ALLOW_ORIGIN,
        beforeFetch: () => checkRateLimit(c.env, config, "imageProxy", member.id),
      });
      if (result instanceof Response) return result;
      if (result.status === 429) return tooManyRequests(c, result.retryAfter, "imageProxy");
      return apiError(c, codeForStatus(result.status), result.reason);
    },
  )

  .get(
    "/sender-logo",
    zValidator(
      "query",
      z.object({ address: z.string().max(320).optional(), domain: z.string().max(253).optional() }),
    ),
    async (c) => {
      const { config, member } = c.var;
      const { address, domain } = c.req.valid("query");
      const source = address ? logoSource(address) : domain ? domainLogoSource(domain) : null;
      if (!source) {
        return new Response(null, {
          status: 404,
          headers: { "cache-control": "private, max-age=86400" },
        });
      }
      const result = await senderLogo(source, {
        dohUrl: config.IMAGE_PROXY_DOH_URL,
        testAllowOrigin: config.IMAGE_PROXY_TEST_ALLOW_ORIGIN,
        iconService: config.SENDER_LOGO_ICON_SERVICE,
        gravatar: config.SENDER_LOGO_GRAVATAR,
        beforeFetch: () => checkRateLimit(c.env, config, "imageProxy", member.id),
      });
      if (result instanceof Response) return result;
      if (result.status === 429) return tooManyRequests(c, result.retryAfter, "imageProxy");
      return apiError(c, codeForStatus(result.status), result.reason);
    },
  )

  .get("/attachments/:sha256{[0-9a-f]{64}}", async (c) => {
    const file = await findMemberAttachmentByHash(c.var.db, c.var.member.id, c.req.param("sha256"));
    if (!file) notFound();
    const object = await c.env.MAIL_BUCKET.get(file.r2Key);
    if (!object) notFound();
    return attachmentResponse(object, file);
  })

  .get("/threads/:id/messages/:messageId/html", async (c) => {
    const htmlR2Key = await findMemberMessageHtml(
      c.var.db,
      c.var.member.id,
      c.req.param("id"),
      c.req.param("messageId"),
    );
    if (!htmlR2Key) notFound();
    const object = await c.env.MAIL_BUCKET.get(htmlR2Key);
    if (!object) notFound();
    const frameAncestors = ["'self'", ...c.var.config.auth.trustedOrigins].join(" ");
    return new Response(object.body, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-security-policy": `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors ${frameAncestors}; sandbox allow-same-origin allow-popups allow-popups-to-escape-sandbox`,
        "cache-control": "private, max-age=3600",
      },
    });
  });
