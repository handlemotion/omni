import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { api, call } from "./api.ts";
import { keys } from "./query-keys.ts";
import type { BusinessHoursInput, Priority, SlaSettings, SlaTargets } from "./types.ts";

export const slaSettingsQuery = (mailboxId: string) =>
  queryOptions({
    queryKey: keys.sla(mailboxId),
    queryFn: ({ signal }) =>
      call(api.mailboxes[":id"].sla.$get({ param: { id: mailboxId } }, { init: { signal } })),
    staleTime: 5 * 60_000,
  });

function settingsMutation<V extends { mailboxId: string }>(
  client: QueryClient,
  request: (vars: V) => Promise<unknown>,
  patch: (settings: SlaSettings, vars: V) => SlaSettings,
  dues: boolean,
) {
  return mutationOptions({
    meta: { handlesError: true },
    mutationFn: request,
    onMutate: async (vars: V) => {
      const key = keys.sla(vars.mailboxId);
      await client.cancelQueries({ queryKey: key });
      const before = client.getQueryData<SlaSettings>(key);
      if (before) client.setQueryData(key, patch(before, vars));
      return { before };
    },
    onError: (_error, { mailboxId }, context) => {
      if (context?.before) client.setQueryData(keys.sla(mailboxId), context.before);
    },
    onSettled: (_data, _error, { mailboxId }) => {
      void client.invalidateQueries({ queryKey: keys.sla(mailboxId) });
      if (!dues) return;
      void client.invalidateQueries({ queryKey: keys.conversationLists() });
      void client.invalidateQueries({ queryKey: keys.conversationCounts() });
      void client.invalidateQueries({
        queryKey: keys.mail(),
        predicate: (query) => query.queryKey.at(-1) === "conversation",
      });
    },
  });
}

/** Sets one priority's targets (minutes; `null` leaves one untracked). */
export const putSlaPolicyMutation = (client: QueryClient) =>
  settingsMutation(
    client,
    ({
      mailboxId,
      priority,
      targets,
    }: {
      mailboxId: string;
      priority: Priority;
      targets: SlaTargets;
    }) =>
      call(
        api.mailboxes[":id"].sla[":priority"].$put({
          param: { id: mailboxId, priority },
          json: targets,
        }),
      ),
    (settings, { priority, targets }) => ({
      ...settings,
      policies: [
        ...settings.policies.filter((p) => p.priority !== priority),
        { priority, businessHoursOnly: true, ...targets },
      ],
    }),
    true,
  );

/** Stops tracking SLAs for one priority. */
export const deleteSlaPolicyMutation = (client: QueryClient) =>
  settingsMutation(
    client,
    ({ mailboxId, priority }: { mailboxId: string; priority: Priority }) =>
      call(api.mailboxes[":id"].sla[":priority"].$delete({ param: { id: mailboxId, priority } })),
    (settings, { priority }) => ({
      ...settings,
      policies: settings.policies.filter((p) => p.priority !== priority),
    }),
    true,
  );

/** Sets when the inbox is staffed: an IANA `timezone`, weekly `windows` (0 is Sunday), `holidays`. */
export const putBusinessHoursMutation = (client: QueryClient) =>
  settingsMutation(
    client,
    ({ mailboxId, hours }: { mailboxId: string; hours: BusinessHoursInput }) =>
      call(api.mailboxes[":id"]["business-hours"].$put({ param: { id: mailboxId }, json: hours })),
    (settings, { hours }) => ({
      ...settings,
      businessHours: {
        timezone: hours.timezone,
        windows: hours.windows,
        holidays: hours.holidays ?? [],
      } as NonNullable<SlaSettings["businessHours"]>,
    }),
    true,
  );

/** Back to always open. */
export const deleteBusinessHoursMutation = (client: QueryClient) =>
  settingsMutation(
    client,
    ({ mailboxId }: { mailboxId: string }) =>
      call(api.mailboxes[":id"]["business-hours"].$delete({ param: { id: mailboxId } })),
    (settings) => ({ ...settings, businessHours: null }),
    true,
  );

/** Turns round-robin auto-assign of new customer conversations on or off. */
export const setAutoAssignMutation = (client: QueryClient) =>
  settingsMutation(
    client,
    ({ mailboxId, enabled }: { mailboxId: string; enabled: boolean }) =>
      call(
        api.mailboxes[":id"]["auto-assign"].$put({ param: { id: mailboxId }, json: { enabled } }),
      ),
    (settings, { enabled }) => ({ ...settings, autoAssign: enabled }),
    false,
  );
