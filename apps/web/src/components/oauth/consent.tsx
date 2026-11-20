import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  IconArrowRotateClockwise,
  IconFolder,
  IconInbox,
  IconKey,
  IconMail,
  IconPencil,
  IconUserAdd,
  IconUserRound,
  IconUsers,
} from "@/components/icons/central";
import { WorkspaceAvatar } from "@/components/settings/workspace-pages";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/field";
import { Heading } from "@/components/ui/heading";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Text } from "@/components/ui/text";
import { appToast } from "@/components/ui/toast";
import { useWorkspaces } from "@/hooks/use-workspaces.ts";
import { answerConsent, oauthClientQuery } from "@/lib/oauth-consent.ts";

const ALL = "all";

type Icon = typeof IconMail;

const SCOPE_LINES: { scopes: string[]; icon: Icon; label: string }[] = [
  {
    scopes: ["openid", "profile", "email"],
    icon: IconUserRound,
    label: "Read identity information",
  },
  { scopes: ["mail:read"], icon: IconMail, label: "Read your mail" },
  { scopes: ["mail:triage"], icon: IconInbox, label: "Sort and file your mail" },
  { scopes: ["mail:draft"], icon: IconPencil, label: "Write drafts for you to send" },
  { scopes: ["crm:read"], icon: IconUsers, label: "Read your CRM" },
  { scopes: ["crm:write"], icon: IconUserAdd, label: "Add and change CRM records" },
  { scopes: ["drive:read"], icon: IconFolder, label: "Read your files" },
  { scopes: ["drive:write"], icon: IconFolder, label: "Write and edit docs" },
  {
    scopes: ["offline_access"],
    icon: IconArrowRotateClockwise,
    label: "Stay connected when you are away",
  },
];

export function Consent({ clientId, scope }: { clientId: string; scope: string }) {
  const client = useQuery(oauthClientQuery(clientId));
  const workspaces = useWorkspaces().data?.workspaces ?? [];
  const [workspace, setWorkspace] = useState(ALL);
  const answer = useMutation({
    mutationFn: answerConsent,
    meta: { handlesError: true },
    onError: () => appToast.error("The request expired. Start the connection again."),
  });
  const requested = new Set(scope.split(" ").filter(Boolean));
  const known = new Set(SCOPE_LINES.flatMap((line) => line.scopes));
  const lines = [
    ...SCOPE_LINES.filter((line) => line.scopes.some((s) => requested.has(s))),
    ...[...requested]
      .filter((s) => !known.has(s))
      .map((s) => ({ scopes: [s], icon: IconKey, label: s })),
  ];
  const name = client.data?.client_name ?? "An app";
  const chosen = workspaces.find((w) => w.id === workspace);
  const decide = (accept: boolean) =>
    answer.mutate({ accept, workspace: workspace === ALL ? null : workspace });

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4">
      <div className="flex w-95 flex-col gap-8 pb-12">
        <div className="flex flex-col items-center gap-1 text-center">
          <Heading className="font-semibold">{name} access request</Heading>
          <Text>{name} is requesting access to your Omni workspace</Text>
        </div>

        <div className="flex flex-col gap-5">
          <Select
            value={workspace}
            onChange={(value) => setWorkspace(value ?? ALL)}
            className="gap-1.5"
          >
            <Label>Select workspace</Label>
            <SelectTrigger
              prefix={chosen ? <WorkspaceAvatar workspace={chosen} size={16} /> : undefined}
            />
            <SelectContent items={[{ id: ALL, name: "All workspaces" }, ...workspaces]}>
              {(item) => (
                <SelectItem id={item.id} textValue={item.name}>
                  {item.name}
                </SelectItem>
              )}
            </SelectContent>
          </Select>

          <div className="flex flex-col gap-1.5">
            <Label elementType="span">Workspace scopes</Label>
            <ul className="flex flex-col gap-2.5 rounded-xl bg-well p-3.5">
              {lines.map(({ label, icon: LineIcon }) => (
                <li key={label} className="flex items-center gap-2.5 text-sm text-foreground">
                  <LineIcon aria-hidden className="size-icon shrink-0 text-muted-foreground" />
                  {label}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Button intent="outline" isDisabled={answer.isPending} onPress={() => decide(false)}>
            Cancel
          </Button>
          <Button
            isPending={answer.isPending && answer.variables?.accept}
            isDisabled={client.isPending}
            onPress={() => decide(true)}
          >
            Confirm
          </Button>
        </div>
      </div>
    </main>
  );
}
