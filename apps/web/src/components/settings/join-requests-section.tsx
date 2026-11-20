import { IconCircleCheck, IconCircleX } from "@/components/icons/central";
import { appToast } from "@/components/ui/toast";
import { useAnswerJoinRequest, useJoinRequests } from "@/hooks/use-join.ts";
import { PersonAvatar } from "./account-pages";
import { SettingsGroup, SettingsSection } from "./kit/settings-layout";
import { SettingsRow } from "./kit/settings-row";
import { SettingsRowMenu } from "./kit/settings-row-menu";

/**
 * People who signed in with this company's address and asked to join, for its owners
 * and admins to accept or decline. Shown only while someone is waiting.
 */
export function JoinRequestsSection(props: { canManage: boolean }) {
  const requests = useJoinRequests(props.canManage).data?.requests;
  const answer = useAnswerJoinRequest();
  if (!props.canManage || !requests?.length) return null;
  const decide = (id: string, choice: "accept" | "decline", name: string) =>
    answer.mutate(
      { id, answer: choice },
      {
        onSuccess: () =>
          appToast.success(choice === "accept" ? `${name} joined` : `Declined ${name}`),
        onError: (error) => appToast.error(error.message || "That didn't go through."),
      },
    );
  return (
    <SettingsSection title="Requests">
      <SettingsGroup>
        {requests.map((request) => {
          const name = request.user.name || request.user.email;
          return (
            <SettingsRow
              key={request.id}
              avatar={<PersonAvatar name={name} image={request.user.image} />}
              label={name}
              description={request.user.name ? request.user.email : undefined}
              control={
                <SettingsRowMenu
                  label={`Actions for ${name}`}
                  items={[
                    {
                      icon: IconCircleCheck,
                      label: "Accept",
                      onAction: () => decide(request.id, "accept", name),
                    },
                    {
                      icon: IconCircleX,
                      label: "Decline",
                      danger: true,
                      onAction: () => decide(request.id, "decline", name),
                    },
                  ]}
                />
              }
            />
          );
        })}
      </SettingsGroup>
    </SettingsSection>
  );
}
