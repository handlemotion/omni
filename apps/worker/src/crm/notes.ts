import {
  crmCreateNoteBodySchema,
  crmUpdateNoteBodySchema,
  type CrmChangedKind,
  type CrmNoteResponse,
} from "@omni/contracts";
import type { CrmNote, CrmRecordRef } from "@omni/db";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../context.ts";
import { zValidator } from "../validator.ts";
import { announce, memberCrm, refused, wireNote } from "./http.ts";

async function announceNote(c: Context<AppEnv>, note: CrmNote) {
  await announce(c, "note", [note.id]);
  const [kind, id]: [CrmChangedKind, string | null] = note.companyId
    ? ["company", note.companyId]
    : note.personId
      ? ["person", note.personId]
      : ["deal", note.dealId];
  await announce(c, kind, [id]);
}

export const notes = new Hono<AppEnv>()
  .post("/notes", zValidator("json", crmCreateNoteBodySchema), async (c) => {
    const { companyId, personId, dealId, body } = c.req.valid("json");
    const record: CrmRecordRef = companyId
      ? { companyId }
      : personId
        ? { personId }
        : { dealId: dealId ?? "" };
    const made = await memberCrm(c).createNote({ record, body });
    if (made.status !== "ok") return refused(c, made);
    await announceNote(c, made.note);
    return c.json({ note: wireNote(made.note) } satisfies CrmNoteResponse, 201);
  })

  .patch("/notes/:id", zValidator("json", crmUpdateNoteBodySchema), async (c) => {
    const changed = await memberCrm(c).updateNote(c.req.param("id"), c.req.valid("json"));
    if (changed.status !== "ok") return refused(c, changed);
    await announceNote(c, changed.note);
    return c.json({ note: wireNote(changed.note) } satisfies CrmNoteResponse);
  })

  .delete("/notes/:id", async (c) => {
    const id = c.req.param("id");
    const deleted = await memberCrm(c).deleteNote(id);
    if (deleted.status !== "ok") return refused(c, deleted);
    await announce(c, "note", [id]);
    return c.body(null, 204);
  });
