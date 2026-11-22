import {
  boolean,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { members } from "../auth.ts";
import { createdAt, id, orgId, updatedAt } from "../columns.ts";

/** In this order: `max()` over a member's rows is the strongest. */
export const storageTeamspaceRole = pgEnum("storage_teamspace_role", ["member", "owner"]);

/**
 * A place in a workspace's Drive that holds folders and files (`docs/spec/teamspaces.md`). Open,
 * every member of the workspace reaches it; private, only its members do.
 */
export const storageTeamspaces = pgTable(
  "storage_teamspaces",
  {
    id: id(),
    orgId: orgId(),
    name: text("name").notNull(),
    private: boolean("private").notNull().default(false),
    /** Its chosen glyph in Drive's sidebar (`STORAGE_FOLDER_ICONS`); null is the default. */
    icon: text("icon"),
    createdByMemberId: text("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("storage_teamspaces_id_org_id_unique").on(t.id, t.orgId),
    index("storage_teamspaces_org_id_idx").on(t.orgId),
  ],
);

/** Who is in a teamspace. Only members of its workspace; leaving the workspace leaves it. */
export const storageTeamspaceMembers = pgTable(
  "storage_teamspace_members",
  {
    teamspaceId: text("teamspace_id").notNull(),
    orgId: orgId(),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    role: storageTeamspaceRole("role").notNull().default("member"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.teamspaceId, t.memberId] }),
    foreignKey({
      name: "storage_teamspace_members_teamspace_org_fk",
      columns: [t.teamspaceId, t.orgId],
      foreignColumns: [storageTeamspaces.id, storageTeamspaces.orgId],
    }).onDelete("cascade"),
    index("storage_teamspace_members_member_id_idx").on(t.memberId),
  ],
);
