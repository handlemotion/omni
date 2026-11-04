// The addresses a person signs in with (ADR 0014). The primary is the account's email; each
// other one is added by a link mailed to it, opened while signed in (`/settings/emails/verify`).
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { api, call } from "./api.ts";
import { keys } from "./query-keys.ts";

export const signInEmailsQuery = () =>
  queryOptions({
    queryKey: keys.signInEmails(),
    queryFn: ({ signal }) => call(api.account.emails.$get(undefined, { init: { signal } })),
  });

const settle = (client: QueryClient) => client.invalidateQueries({ queryKey: keys.signInEmails() });

/** Mails a confirmation link. Nothing changes until it is opened. */
export const addSignInEmailMutation = () =>
  mutationOptions({
    mutationFn: (email: string) => call(api.account.emails.$post({ json: { email } })),
  });

/** Confirms the address from its link's token. Single-use on the server. */
export const verifySignInEmailMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: (token: string) => call(api.account.emails.verify.$post({ json: { token } })),
    onSettled: () => settle(client),
  });

/** The session's user email changes with it, so the session is refetched too. */
export const setPrimarySignInEmailMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: (email: string) => call(api.account.emails.primary.$post({ json: { email } })),
    onSettled: () =>
      Promise.all([settle(client), client.invalidateQueries({ queryKey: keys.session() })]),
  });

export const removeSignInEmailMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: (email: string) => call(api.account.emails[":email"].$delete({ param: { email } })),
    onSettled: () => settle(client),
  });
