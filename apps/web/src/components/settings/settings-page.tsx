import type { ReactNode } from "react";
import { Heading } from "@/components/ui/heading";
import { PageNav, usePageNavShown } from "@/components/shell/page-nav";
import type { SettingsPageId } from "@/hooks/use-settings.ts";
import { usePersonalWorkspace } from "@/hooks/use-workspaces.ts";
import { ProfilePage, SecurityPage, ShortcutsPage } from "./account-pages";
import { AiPage } from "./ai-page";
import { BillingPage } from "./billing-page";
import { ConnectedAccountsPage } from "./connected-accounts-page";
import { ForwardingPage } from "./forwarding-page";
import { HelpdeskPage } from "./helpdesk-pages";
import { SettingsPageHeader } from "./kit/settings-layout";
import { InboxesPage, SharedMailboxesPage } from "./mailbox-pages";
import { NotificationsPage } from "./notification-pages";
import { DriveSyncPage } from "./sync-pages";
import { PipelinePage } from "./pipeline-page";
import { GeneralPage, PeoplePage } from "./workspace-pages";
import {
  COMPANY_PAGES,
  type PageDefinition,
  useAccountPages,
  WORKSPACE_PAGES,
} from "./settings-pages";

const BODIES: Record<SettingsPageId, () => ReactNode> = {
  profile: () => <ProfilePage />,
  security: () => <SecurityPage />,
  shortcuts: () => <ShortcutsPage />,
  notifications: () => <NotificationsPage />,
  accounts: () => <ConnectedAccountsPage />,
  forwarding: () => <ForwardingPage />,
  sync: () => <DriveSyncPage />,
  general: () => <GeneralPage />,
  people: () => <PeoplePage />,
  inboxes: () => <InboxesPage />,
  shared: () => <SharedMailboxesPage />,
  helpdesk: () => <HelpdeskPage />,
  pipeline: () => <PipelinePage />,
  ai: () => <AiPage />,
  billing: () => <BillingPage />,
};

const [GENERAL] = WORKSPACE_PAGES as [PageDefinition, ...PageDefinition[]];

export function SettingsPage({ page }: { page: SettingsPageId }) {
  const account = useAccountPages();
  const personal = usePersonalWorkspace();
  const allowed = WORKSPACE_PAGES.filter((p) => !(personal && COMPANY_PAGES.has(p.id)));
  const current = [...account, ...allowed].find((p) => p.id === page) ?? GENERAL;
  const title = current.id === "profile" ? "Profile" : current.title;
  const pageNav = usePageNavShown();

  return (
    <section className="flex h-svh min-h-0 min-w-0 flex-col">
      <header
        className={`flex h-12 shrink-0 items-center gap-2 border-b border-border pe-2.5 ${pageNav ? "ps-2.5" : "ps-5"}`}
      >
        <PageNav />
        <Heading className="min-w-0 truncate text-md">{title}</Heading>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-160 px-6 pt-10 pb-16 md:px-12">
          <SettingsPageHeader title={title} />
          {BODIES[current.id]()}
        </div>
      </div>
    </section>
  );
}
