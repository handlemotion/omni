import { CRM_PAGES } from "@/lib/crm.ts";
import { DRIVE_PAGES, useTeamspaces } from "@/lib/drive.ts";
import { MAIL_PAGES } from "@/lib/mail.ts";
import { useMenuPlace } from "./menu-nav.ts";
import { useModules } from "./modules.ts";

/** The title of the module root page on screen: its page or teamspace, else the module's name. */
export function usePageTitle() {
  const place = useMenuPlace();
  const modules = useModules();
  const teamspaces = useTeamspaces().data;
  if (place.mailPage) return MAIL_PAGES[place.mailPage].label;
  if (place.crmPage) return CRM_PAGES[place.crmPage].label;
  if (place.drivePage) return DRIVE_PAGES[place.drivePage].label;
  const space = place.driveSpace && teamspaces?.find((one) => one.id === place.driveSpace);
  if (space) return space.name;
  return modules.find((entry) => entry.id === place.module)?.label ?? "";
}
