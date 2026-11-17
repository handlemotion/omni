import { queryOptions } from "@tanstack/react-query";
import { api, auth, call } from "./api.ts";
import { keys } from "./query-keys.ts";

export interface OAuthClient {
  client_id: string;
  client_name?: string;
  logo_uri?: string;
}

export const oauthClientQuery = (clientId: string) =>
  queryOptions({
    queryKey: [...keys.oauthClients(), clientId],
    queryFn: async () => {
      const { data, error } = await auth.$fetch<OAuthClient>("/oauth2/public-client", {
        query: { client_id: clientId },
      });
      if (error) throw new Error(error.message ?? "unknown client");
      return data;
    },
  });

/**
 * Accepts (for `workspace`, or every workspace when null) or denies, then leaves for the agent.
 * The workspace is recorded first: the grant reads it as it is made.
 */
export async function answerConsent(answer: { accept: boolean; workspace: string | null }) {
  if (answer.accept) {
    await call(api.oauth.workspace.$post({ json: { workspace: answer.workspace } }));
  }
  const { data, error } = await auth.$fetch<{ url: string }>("/oauth2/consent", {
    method: "POST",
    body: { accept: answer.accept, oauth_query: window.location.search.slice(1) },
  });
  if (error || !data) throw new Error(error?.message ?? "the request has expired");
  window.location.assign(data.url);
}
