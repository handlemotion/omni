import { STORAGE_LINK_KEY_HEADER } from "@omni/contracts";
import { guestOfKey, signGuestKey } from "@omni/crypto";
import { guestName } from "@omni/docs/presence";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../context.ts";

export const COOKIE = "omni_link_key";
const GUEST_COOKIE = "omni_guest";
const GUEST_MS = 30 * 24 * 60 * 60 * 1000;
export const cookiePath = (shareId: string) => `/api/storage/shared/${encodeURIComponent(shareId)}`;

/** The guest the visitor is on this link, from their guest cookie; null when they have none. */
export async function guestFrom(c: Context<AppEnv>, shareId: string) {
  const key = getCookie(c, GUEST_COOKIE);
  const id = key ? await guestOfKey(c.var.config.auth.secret, shareId, key) : null;
  return id ? { id, name: guestName(id) } : null;
}

/** Gives the visitor a guest key for the link, so their comments and edits are theirs. */
export async function mintGuest(c: Context<AppEnv>, shareId: string) {
  const expiresAt = new Date(Date.now() + GUEST_MS);
  const { guestId, key } = await signGuestKey(c.var.config.auth.secret, shareId, expiresAt);
  setCookie(c, GUEST_COOKIE, key, {
    path: cookiePath(shareId),
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    expires: expiresAt,
  });
  return { id: guestId, name: guestName(guestId) };
}

/** The password key the visitor presents: its header from a native client, else its cookie. */
export const presentedKey = (c: Context<AppEnv>) =>
  c.req.header(STORAGE_LINK_KEY_HEADER) ?? getCookie(c, COOKIE) ?? null;
