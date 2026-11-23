import { sha256Hex } from "@omni/crypto";
import { setOrganizationLogo, setUserImage } from "@omni/db";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireUser, type AppEnv } from "../context.ts";
import { imageHeaders } from "../image-proxy.ts";
import { managersOnly } from "../inbox-admin.ts";
import { pictureUpload, readPicture } from "../picture-file.ts";

type Owner = "users" | "orgs";

const pictureUrl = (owner: Owner, ownerId: string, sha256: string) =>
  `/api/pictures/${owner}/${ownerId}/${sha256}`;
const pictureKey = (owner: Owner, ownerId: string, sha256: string) =>
  `pictures/${owner}/${ownerId}/${sha256}`;

/**
 * The bucket key behind a URL this owner's picture was set to, or null. Only our own URL for this
 * same owner counts: `users.image` can also hold a URL from elsewhere (Better Auth's
 * `updateUser`), and removing that must never delete another owner's object.
 */
export function pictureKeyOf(url: string | null | undefined, owner: Owner, ownerId: string) {
  const [, urlOwner, urlOwnerId, sha256] =
    url?.match(/^\/api\/pictures\/(users|orgs)\/([^/]+)\/([0-9a-f]{64})$/) ?? [];
  if (!sha256 || urlOwner !== owner || urlOwnerId !== ownerId) return null;
  return pictureKey(owner, ownerId, sha256);
}

async function storePicture(c: Context<AppEnv>, file: File, owner: Owner, ownerId: string) {
  const { bytes, contentType } = await readPicture(file);
  const sha256 = await sha256Hex(bytes);
  await c.env.MAIL_BUCKET.put(pictureKey(owner, ownerId, sha256), bytes, {
    httpMetadata: { contentType },
  });
  return pictureUrl(owner, ownerId, sha256);
}

async function dropReplaced(
  c: Context<AppEnv>,
  previous: string | null | undefined,
  current: string | null,
  owner: Owner,
  ownerId: string,
) {
  const key = previous !== current && pictureKeyOf(previous, owner, ownerId);
  if (key) await c.env.MAIL_BUCKET.delete(key);
}

/** `/api/account`: the signed-in user's own picture. Works before they join an organization. */
export const account = new Hono<AppEnv>()
  .use(requireUser)
  .put("/picture", ...pictureUpload, async (c) => {
    const { id } = c.var.user;
    const image = await storePicture(c, c.req.valid("form").file, "users", id);
    const previous = await setUserImage(c.var.db, id, image);
    await dropReplaced(c, previous, image, "users", id);
    return c.json({ image });
  })
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
  .use(managersOnly("only owners and admins change the logo"))
  .put("/logo", ...pictureUpload, async (c) => {
    const { orgId } = c.var.member;
    const logo = await storePicture(c, c.req.valid("form").file, "orgs", orgId);
    const previous = await setOrganizationLogo(c.var.db, orgId, logo);
    await dropReplaced(c, previous, logo, "orgs", orgId);
    return c.json({ logo });
  })
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
