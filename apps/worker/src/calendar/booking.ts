import {
  bookingBodySchema,
  bookingLinkCreateBodySchema,
  bookingLinkUpdateBodySchema,
  type BookingLink,
  type BookingLinkListResponse,
  type BookingLinkResponse,
  type BookingPageResponse,
  type BookingResponse,
} from "@omni/contracts";
import { bookingLinkOrg, bookingPage, bookSlot, type BookingLinkView } from "@omni/db";
import { Hono, type Context } from "hono";
import { inGoodStanding } from "../billing.ts";
import type { AppEnv } from "../context.ts";
import { pingMailService } from "../mail-service.ts";
import { checkRateLimit, clientIp, tooManyRequests, type RateLimitRule } from "../rate-limiter.ts";
import { zValidator } from "../validator.ts";
import { announceCalendars, memberCalendar, refused } from "./http.ts";

const wireLink = (link: BookingLinkView) =>
  ({ ...link, createdAt: link.createdAt.toISOString() }) satisfies BookingLink;

/** The member's booking links (`docs/spec/calendar.md`, "Booking links"), under `/api/calendar`. */
export const bookingLinks = new Hono<AppEnv>()
  .get("/booking-links", async (c) => {
    const links = await memberCalendar(c).bookingLinks();
    return c.json({ links: links.map(wireLink) } satisfies BookingLinkListResponse);
  })

  .post("/booking-links", zValidator("json", bookingLinkCreateBodySchema), async (c) => {
    const made = await memberCalendar(c).createBookingLink(c.req.valid("json"));
    if (made.status !== "ok") return refused(c, made);
    return c.json({ link: wireLink(made.link) } satisfies BookingLinkResponse, 201);
  })

  .patch("/booking-links/:id", zValidator("json", bookingLinkUpdateBodySchema), async (c) => {
    const changed = await memberCalendar(c).updateBookingLink(
      c.req.param("id"),
      c.req.valid("json"),
    );
    if (changed.status !== "ok") return refused(c, changed);
    return c.json({ link: wireLink(changed.link) } satisfies BookingLinkResponse);
  })

  .delete("/booking-links/:id", async (c) => {
    const deleted = await memberCalendar(c).deleteBookingLink(c.req.param("id"));
    if (deleted.status !== "ok") return refused(c, deleted);
    return c.body(null, 204);
  });

async function limited(c: Context<AppEnv>, rule: RateLimitRule) {
  const wait = await checkRateLimit(c.env, c.var.config, rule, clientIp(c.req.raw));
  return wait ? tooManyRequests(c, wait, rule) : null;
}

async function takesBookings(c: Context<AppEnv>, slug: string) {
  const orgId = await bookingLinkOrg(c.var.db, slug);
  return orgId !== null && inGoodStanding(c.var.db, c.var.config, orgId);
}

/**
 * The public booking page, for visitors with no account: the slots left on a link and nothing
 * of what fills the rest, and booking one. Per IP: reads by `booking`, bookings by `bookingNew`,
 * since each one sends mail from the owner's inbox.
 */
export const bookingPublic = new Hono<AppEnv>()
  .get("/:slug", async (c) => {
    const refusal = await limited(c, "booking");
    if (refusal) return refusal;
    const slug = c.req.param("slug");
    if (!(await takesBookings(c, slug))) return refused(c, { status: "not_found" });
    const found = await bookingPage(c.var.db, slug);
    if (found.status !== "ok") return refused(c, found);
    const { page } = found;
    c.header("cache-control", "no-store");
    return c.json({
      ...page,
      slots: page.slots.map((slot) => slot.toISOString()),
    } satisfies BookingPageResponse);
  })

  .post("/:slug", zValidator("json", bookingBodySchema), async (c) => {
    const refusal = await limited(c, "bookingNew");
    if (refusal) return refusal;
    const slug = c.req.param("slug");
    if (!(await takesBookings(c, slug))) return refused(c, { status: "not_found" });
    const body = c.req.valid("json");
    const booked = await bookSlot(
      c.var.db,
      slug,
      { ...body, start: new Date(body.start) },
      c.var.requestId,
    );
    if (booked.status !== "ok") return refused(c, booked);
    c.executionCtx.waitUntil(pingMailService(c.var));
    c.executionCtx.waitUntil(
      announceCalendars(c.env, c.var.db, c.var.log, [
        { calendarId: booked.calendarId, mailboxId: booked.mailboxId },
      ]),
    );
    return c.json(
      {
        start: booked.start.toISOString(),
        end: booked.end.toISOString(),
      } satisfies BookingResponse,
      201,
    );
  });
