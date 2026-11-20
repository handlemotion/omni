import { useMember } from "@/hooks/use-session.ts";

/**
 * Whether the viewer works here as a freelancer. The server leaves out what we charge for them
 * (`docs/spec/crm.md`, "What we charge stays with the team"), so value fields, columns, filters
 * and sorts are not shown to them at all.
 */
export function useFreelancer() {
  const { member } = useMember();
  return member.role.split(",").some((role) => role.trim() === "freelancer");
}

/** Without what a freelancer cannot see: anything about value. */
export const withoutValue = <T>(items: T[], isValue: (item: T) => boolean, freelancer: boolean) =>
  freelancer ? items.filter((item) => !isValue(item)) : items;
