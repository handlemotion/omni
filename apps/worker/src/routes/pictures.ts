// Profile pictures (the signed-in user's `users.image`) and workspace logos (the active org's
// `organizations.logo`). The bytes live in MAIL_BUCKET under `pictures/`, keyed by owner and
// content hash, and are served back through `/api/pictures/...` on our own origin: a new upload
// is a new URL, so a served picture never changes and caches for a year.
import { zValidator } from "@hono/zod-validator";
import { setOrganizationLogo, setUserImage } from "@omni/db";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { resolveSession, type AppEnv } from "../context.ts";
import { imageHeaders } from "../image-proxy.ts";

/** Largest picture accepted. */
export const MAX_PICTURE_BYTES = 2 * 1024 * 1024;

type Owner = "users" | "orgs";

/**
 * The image type from the file's first bytes, or null. The declared type is the client's word;
 * these are the only types we serve inline on our origin, so they are checked, never trusted.
 */
function sniffImageType(bytes: Uint8Array): string | null {
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39)) {
    return bytes[5] === 0x61 ? "image/gif" : null;
  }
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const pictureUrl = (owner: Owner, ownerId: string, sha256: string) =>
  `/api/pictures/${owner}/${ownerId}/${sha256}`;
const pictureKey = (owner: Owner, ownerId: string, sha256: string) =>
  `pictures/${owner}/${ownerId}/${sha256}`;

/**
 * The bucket key behind a URL this owner's picture was set to, or null. Only our own URL for this
 * same owner counts: `users.image` can also hold a URL from elsewhere (Better Auth's
 * `updateUser`), and removing that must never delete another owner's object.
 */
function keyOf(url: string | null | undefined, owner: Owner, ownerId: string) {
  const [, urlOwner, urlOwnerId, sha256] =
    url?.match(/^\/api\/pictures\/(users|orgs)\/([^/]+)\/([0-9a-f]{64})$/) ?? [];
  if (!sha256 || urlOwner !== owner || urlOwnerId !== ownerId) return null;
  return pictureKey(owner, ownerId, sha256);
}

/** The multipart field `file`; the body cap leaves room for the multipart envelope. */
const upload = [
  bodyLimit({
    maxSize: MAX_PICTURE_BYTES + 64 * 1024,
    onError: (c) => c.json({ error: "the picture is larger than 2 MB" }, 413),
  }),
  zValidator("form", z.object({ file: z.instanceof(File) }), (result, c) => {
    if (!result.success) return c.json({ error: "send the picture as the form field `file`" }, 400);
  }),
] as const;

/** Checks the upload, stores it, and returns its URL. */
async function storePicture(c: Context<AppEnv>, file: File, owner: Owner, ownerId: string) {
  if (file.size > MAX_PICTURE_BYTES) {
    throw new HTTPException(413, { message: "the picture is larger than 2 MB" });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentType = sniffImageType(bytes);
  if (!contentType) {
    throw new HTTPException(415, { message: "the picture must be a PNG, JPEG, WebP or GIF" });
  }
  const sha256 = await sha256Hex(bytes);
  await c.env.MAIL_BUCKET.put(pictureKey(owner, ownerId, sha256), bytes, {
    httpMetadata: { contentType },
  });
  return pictureUrl(owner, ownerId, sha256);
}

/** Deletes the object behind the replaced URL, unless it is the one now in use. */
async function dropReplaced(
  c: Context<AppEnv>,
  previous: string | null | undefined,
  current: string | null,
  owner: Owner,
  ownerId: string,
) {
  const key = previous !== current && keyOf(previous, owner, ownerId);
  // R2 deletes are idempotent: a key already gone is not an error.
  if (key) await c.env.MAIL_BUCKET.delete(key);
}

/** The signed-in user, organization or not. 401 when signed out. */
const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const resolved = await resolveSession(c);
  if (!resolved) throw new HTTPException(401, { message: "sign in first" });
  c.set("user", resolved.user);
  await next();
});

function canManage(role: string) {
  return role.split(",").some((r) => r.trim() === "owner" || r.trim() === "admin");
}

/** `/api/account`: the signed-in user's own picture. Works before they join an organization. */
export const account = new Hono<AppEnv>()
  .use(requireUser)
  /** Sets your picture from multipart `file` (PNG, JPEG, WebP or GIF, at most 2 MB). */
  .put("/picture", ...upload, async (c) => {
    const { id } = c.var.user;
    const image = await storePicture(c, c.req.valid("form").file, "users", id);
    const previous = await setUserImage(c.var.db, id, image);
    await dropReplaced(c, previous, image, "users", id);
    return c.json({ image });
  })
  /** Clears your picture. Idempotent. */
  .delete("/picture", async (c) => {
    const { id } = c.var.user;
    const previous = await setUserImage(c.var.db, id, null);
    await dropReplaced(c, previous, null, "users", id);
    return c.json({ image: null });
  });

/**
 * `/api/workspace`: the active organization's logo. Owners and admins only. Mounted under the
 * member routes, so the org is always the session's active one.
 */
export const workspaceLogo = new Hono<AppEnv>()
  .use(async (c, next) => {
    if (!canManage(c.var.member.role)) {
      throw new HTTPException(403, { message: "only owners and admins change the logo" });
    }
    await next();
  })
  /** Sets the logo from multipart `file` (PNG, JPEG, WebP or GIF, at most 2 MB). */
  .put("/logo", ...upload, async (c) => {
    const { orgId } = c.var.member;
    const logo = await storePicture(c, c.req.valid("form").file, "orgs", orgId);
    const previous = await setOrganizationLogo(c.var.db, orgId, logo);
    await dropReplaced(c, previous, logo, "orgs", orgId);
    return c.json({ logo });
  })
  /** Clears the logo. Idempotent. */
  .delete("/logo", async (c) => {
    const { orgId } = c.var.member;
    const previous = await setOrganizationLogo(c.var.db, orgId, null);
    await dropReplaced(c, previous, null, "orgs", orgId);
    return c.json({ logo: null });
  });

/**
 * `/api/pictures/<users|orgs>/<id>/<sha256>`: a stored picture, for any signed-in user (pictures
 * show next to people and workspaces across orgs). The URL names its content, so it is immutable.
 */
export const pictures = new Hono<AppEnv>()
  .use(requireUser)
  .get("/:owner{users|orgs}/:ownerId/:sha256{[0-9a-f]{64}}", async (c) => {
    const { owner, ownerId, sha256 } = c.req.param();
    const object = await c.env.MAIL_BUCKET.get(pictureKey(owner as Owner, ownerId, sha256));
    if (!object) throw new HTTPException(404, { message: "not found" });
    return new Response(object.body, {
      headers: {
        ...imageHeaders(object.httpMetadata?.contentType ?? "application/octet-stream"),
        "content-length": String(object.size),
        etag: object.httpEtag,
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  });
