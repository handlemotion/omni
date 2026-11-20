import {
  portalReviewBodySchema,
  type PortalProjectResponse,
  type PortalProjectsResponse,
} from "@omni/contracts";
import { forUser, type PortalFile, type PortalProjectDetail } from "@omni/db";
import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { resolveSession, type AppEnv } from "../context.ts";
import { apiError } from "../errors.ts";
import { zValidator } from "../validator.ts";

const iso = (date: Date) => date.toISOString();
const isoOrNull = (date: Date | null) => (date ? date.toISOString() : null);
const wireFile = (file: PortalFile) => ({ ...file, updatedAt: iso(file.updatedAt) });

const wireDetail = (detail: PortalProjectDetail) =>
  ({
    project: detail.project,
    milestones: detail.milestones.map((m) => ({
      ...m,
      completedAt: isoOrNull(m.completedAt),
      createdAt: iso(m.createdAt),
      updatedAt: iso(m.updatedAt),
    })),
    deliverables: detail.deliverables.map((d) => ({
      ...d,
      file: d.file ? wireFile(d.file) : null,
      reviewedAt: isoOrNull(d.reviewedAt),
      createdAt: iso(d.createdAt),
      updatedAt: iso(d.updatedAt),
    })),
    contracts: detail.contracts.map((c) => ({ ...c, signedAt: isoOrNull(c.signedAt) })),
    folder: detail.folder
      ? {
          id: detail.folder.id,
          shareId: detail.folder.shareId,
          files: detail.folder.files.map(wireFile),
        }
      : null,
  }) satisfies PortalProjectResponse;

const signedIn = createMiddleware<AppEnv>(async (c, next) => {
  const session = await resolveSession(c);
  if (!session) return apiError(c, "unauthorized", "sign in first");
  c.set("user", session.user);
  await next();
});

const clientCrm = (c: Context<AppEnv>) =>
  forUser(c.var.db, c.var.user.id, c.var.user.scopeOrgId).crm;

const notFound = (c: Context<AppEnv>) => apiError(c, "not_found", "not found");

/**
 * The client portal (`docs/spec/crm.md`, "Client portal"): a signed-in person who needs no
 * workspace, reaching the projects their verified addresses were added to as a client.
 */
export const portal = new Hono<AppEnv>()
  .use(signedIn)
  .get("/projects", async (c) => {
    const found = await clientCrm(c).projects();
    return c.json({ projects: found.projects } satisfies PortalProjectsResponse);
  })

  .get("/projects/:id", async (c) => {
    const found = await clientCrm(c).project(c.req.param("id"));
    if (found.status !== "ok") return notFound(c);
    return c.json(wireDetail(found.detail));
  })

  .post(
    "/projects/:id/deliverables/:deliverableId/review",
    zValidator("json", portalReviewBodySchema),
    async (c) => {
      const reviewed = await clientCrm(c).reviewDeliverable(
        c.req.param("id"),
        c.req.param("deliverableId"),
        c.req.valid("json"),
      );
      if (reviewed.status === "not_in_review") {
        return apiError(c, "conflict", "that deliverable is not waiting for your review");
      }
      if (reviewed.status === "note_required") {
        return apiError(c, "bad_request", "say what should change", { param: "note" });
      }
      if (reviewed.status !== "ok") return notFound(c);
      return c.json(wireDetail(reviewed.detail));
    },
  );
