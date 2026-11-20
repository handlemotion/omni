import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { apiError } from "../errors.ts";

/**
 * The iOS app's universal links: with `IOS_APP_IDS` set, iOS opens this host's share links
 * (`/s/<id>`) in the app instead of Safari. Unset, there is nothing to associate.
 */
export const appLinks = new Hono<AppEnv>().get("/.well-known/apple-app-site-association", (c) => {
  const appIDs = c.var.config.IOS_APP_IDS;
  if (appIDs.length === 0) return apiError(c, "not_found", "no iOS app");
  return c.json({ applinks: { details: [{ appIDs, components: [{ "/": "/s/*" }] }] } });
});
