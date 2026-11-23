import { router, useGlobalSearchParams, usePathname } from "expo-router";
import { createContext, use } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { isCrmPage, type CrmPage } from "@/lib/crm.ts";
import { drivePageIn, type DrivePage } from "@/lib/drive.ts";
import { isMailPage, type MailPage } from "@/lib/mail.ts";
import { hasCrm, useWorkspace } from "@/lib/workspace.ts";
import { space } from "@/theme/tokens.ts";

/** The shell's round buttons (☰, the workspace) and the top bar's height below the status bar. */
export const SHELL_CONTROL = space(11);
const SHELL_BAR = space(2) + SHELL_CONTROL + space(2.5);

/** Where a module's root page starts: under the shell's top bar and its hairline. */
export function useShellTop() {
  return useSafeAreaInsets().top + SHELL_BAR;
}

export type Module = "mail" | "drive" | "crm" | "calendar";

export const MODULE_HOME = {
  mail: "/mail",
  drive: "/drive",
  crm: "/crm",
  calendar: "/calendar",
} as const;

function moduleOf(pathname: string) {
  let module: Module = "mail";
  if (pathname.startsWith("/drive")) module = "drive";
  else if (pathname.startsWith("/crm")) module = "crm";
  else if (pathname.startsWith("/calendar")) module = "calendar";
  return module;
}

type PlaceParams = { page?: string; mailbox?: string };

/**
 * The module root page the shell's chrome is drawn on, with that page's own params. The chrome
 * reads its place from here, not from the global route, which already names a pushed page while
 * that page still slides in or out over the root.
 */
export const RootPlace = createContext<{ module: Module; params: PlaceParams } | null>(null);

/**
 * Where the app is, as the menu marks it, and how the menu moves: a module replaces the one on
 * screen (the menu is not a history), and a page or mailbox changes a module's root in place
 * when it is already showing.
 */
export function useMenuPlace() {
  const root = use(RootPlace);
  const pathname = usePathname();
  const global = useGlobalSearchParams<PlaceParams>();
  const company = hasCrm(useWorkspace().active);
  const module = root?.module ?? moduleOf(pathname);
  const onRoot = root ? true : pathname === MODULE_HOME[module];
  const params = root?.params ?? global;
  const mailPage: MailPage | undefined =
    onRoot && module === "mail" ? (isMailPage(params.page) ? params.page : "inbox") : undefined;
  const drivePage: DrivePage | undefined =
    onRoot && module === "drive" ? drivePageIn(params.page, company) : undefined;
  const crmPage: CrmPage | undefined =
    onRoot && module === "crm" ? (isCrmPage(params.page) ? params.page : "companies") : undefined;
  const mailbox = mailPage ? params.mailbox : undefined;

  const openModule = (next: Module) => {
    if (next !== module || !onRoot) router.replace(MODULE_HOME[next]);
  };

  const openPage = (next: Module, page: string) => {
    if (next === module && onRoot) router.setParams({ page });
    else router.replace({ pathname: MODULE_HOME[next], params: { page } });
  };

  const openMail = (next: { page?: MailPage; mailbox?: string | null }) => {
    const target = {
      page: next.page ?? mailPage ?? "inbox",
      mailbox: next.mailbox === undefined ? mailbox : (next.mailbox ?? undefined),
    };
    if (module === "mail" && onRoot) {
      router.setParams(target);
      return;
    }
    router.replace({ pathname: "/mail", params: target.mailbox ? target : { page: target.page } });
  };

  return { module, onRoot, mailPage, drivePage, crmPage, mailbox, openModule, openPage, openMail };
}
