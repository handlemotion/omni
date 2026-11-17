import {
  crmAddPersonBodySchema,
  crmDeleteQuerySchema,
  crmPeopleQuerySchema,
  crmUpdatePersonBodySchema,
  type CrmAddPersonResponse,
  type CrmPersonDetailResponse,
  type CrmPersonListResponse,
  type CrmPersonResponse,
} from "@omni/contracts";
import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { zValidator } from "../validator.ts";
import { lastContactedAt, subjectOf } from "./mail.ts";
import {
  announce,
  decodeCursor,
  encodeCursor,
  memberCrm,
  nameCursor,
  refused,
  wirePerson,
} from "./http.ts";

export const people = new Hono<AppEnv>()
  .get("/people", zValidator("query", crmPeopleQuerySchema), async (c) => {
    const { q, company, cursor, limit, archived } = c.req.valid("query");
    const listed = await memberCrm(c).listPeople({
      q,
      companyId: company,
      cursor: decodeCursor(cursor, nameCursor),
      limit,
      includeArchived: archived === "1",
    });
    if (listed.status !== "ok") return refused(c, listed);
    return c.json({
      people: listed.people.map(wirePerson),
      nextCursor: encodeCursor(listed.nextCursor),
    } satisfies CrmPersonListResponse);
  })

  .post("/people", zValidator("json", crmAddPersonBodySchema), async (c) => {
    const added = await memberCrm(c).addPerson(c.req.valid("json"));
    if (added.status !== "ok") return refused(c, added);
    const { person, created } = added;
    if (created) {
      await announce(c, "person", [person.id]);
      await announce(c, "company", [person.companyId]);
    }
    return c.json(
      { person: wirePerson(person), created } satisfies CrmAddPersonResponse,
      created ? 201 : 200,
    );
  })

  .get("/people/:id", async (c) => {
    const found = await memberCrm(c).person(c.req.param("id"));
    if (found.status !== "ok") return refused(c, found);
    return c.json({
      person: wirePerson(found.person),
      lastContactedAt: await lastContactedAt(c, subjectOf([found.person])),
    } satisfies CrmPersonDetailResponse);
  })

  .patch("/people/:id", zValidator("json", crmUpdatePersonBodySchema), async (c) => {
    const crm = memberCrm(c);
    const id = c.req.param("id");
    const before = await crm.person(id);
    const changed = await crm.updatePerson(id, c.req.valid("json"));
    if (changed.status !== "ok") return refused(c, changed);
    await announce(c, "person", [id]);
    const was = before.status === "ok" ? before.person.companyId : null;
    if (was !== changed.person.companyId)
      await announce(c, "company", [was, changed.person.companyId]);
    return c.json({ person: wirePerson(changed.person) } satisfies CrmPersonResponse);
  })

  .delete("/people/:id", zValidator("query", crmDeleteQuerySchema), async (c) => {
    const id = c.req.param("id");
    const crm = memberCrm(c);
    if (c.req.valid("query").forever) {
      const deleted = await crm.deletePerson(id);
      if (deleted.status !== "ok") return refused(c, deleted);
      await announce(c, "person", [id]);
      return c.body(null, 204);
    }
    const archived = await crm.archivePerson(id);
    if (archived.status !== "ok") return refused(c, archived);
    await announce(c, "person", [id]);
    return c.json({ person: wirePerson(archived.person) } satisfies CrmPersonResponse);
  });
