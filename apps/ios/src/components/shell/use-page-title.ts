import { CRM_PAGES } from "@/lib/crm.ts";
import { DRIVE_PAGES } from "@/lib/drive.ts";
import { useMailPageCounts } from "@/lib/mail-counts.ts";
import { MAIL_PAGES } from "@/lib/mail.ts";
import { useMenuPlace } from "./menu-nav.ts";

/** The root page on screen, as the top bar names it: its label, and Mail's count beside it. */
export function usePageTitle() {
  const place = useMenuPlace();
  const counts: Partial<Record<string, string>> = useMailPageCounts(place.mailbox);
  if (place.mailPage)
    return { title: MAIL_PAGES[place.mailPage].label, count: counts[place.mailPage] };
  if (place.drivePage) return { title: DRIVE_PAGES[place.drivePage].label };
  if (place.crmPage) return { title: CRM_PAGES[place.crmPage].label };
  if (place.module === "calendar") return { title: "Calendar" };
  return { title: "" };
}
