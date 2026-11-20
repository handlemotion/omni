import { Redirect, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { CrmSearch } from "@/components/crm/crm-search.tsx";
import { DealBoard } from "@/components/crm/deal-board.tsx";
import { ListControls } from "@/components/crm/list-controls.tsx";
import { CompanyList, DealList, PersonList } from "@/components/crm/record-lists.tsx";
import { FLOATING_BAR_SPACE } from "@/components/shell/floating-bar.tsx";
import { useMenu } from "@/components/shell/menu-context.tsx";
import { ModuleRoot } from "@/components/shell/module-root.tsx";
import { DEFAULT_VIEW, isCrmPage, type CrmPage, type ListView } from "@/lib/crm-lists.ts";
import { useDebounced } from "@/lib/use-debounced.ts";
import { hasCrm, useWorkspace } from "@/lib/workspace.ts";

/**
 * A CRM list: Companies, People, Deals (as a list or a board) or Projects, each with its own
 * order and filters, kept while you move between them. A Personal space has no CRM: it goes to
 * Mail.
 */
export default function CrmHome() {
  const params = useLocalSearchParams<{ page?: string }>();
  const page = isCrmPage(params.page) ? params.page : "companies";
  const typed = useMenu().query.trim();
  const q = useDebounced(typed);
  const [views, setViews] = useState<Partial<Record<CrmPage, ListView>>>({});
  const [board, setBoard] = useState(false);
  const view = views[page] ?? DEFAULT_VIEW;
  const crm = hasCrm(useWorkspace().active);
  if (!crm) return <Redirect href="/mail" />;
  return (
    <ModuleRoot module="crm">
      {typed ? (
        <CrmSearch q={q} footerSpace={FLOATING_BAR_SPACE} />
      ) : (
        <View style={styles.page}>
          <ListControls
            page={page}
            view={view}
            onChange={(next) => setViews((all) => ({ ...all, [page]: next }))}
            board={page === "deals" ? { on: board, toggle: () => setBoard(!board) } : undefined}
          />
          <PageList page={page} view={view} board={board} />
        </View>
      )}
    </ModuleRoot>
  );
}

function PageList({ page, view, board }: { page: CrmPage; view: ListView; board: boolean }) {
  if (page === "people") return <PersonList view={view} />;
  if (page === "projects") return <DealList view={view} projects />;
  if (page === "deals") return board ? <DealBoard view={view} /> : <DealList view={view} />;
  return <CompanyList view={view} />;
}

const styles = StyleSheet.create({ page: { flex: 1 } });
