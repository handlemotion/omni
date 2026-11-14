import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { Consent } from "../../../components/oauth/consent.tsx";
import { oauthClientQuery } from "../../../lib/oauth-consent.ts";
import { workspacesQuery } from "../../../lib/workspaces.ts";

/**
 * An agent asking to connect (ADR 0029). Better Auth's OAuth provider sends a signed-in person
 * here with the signed authorization request; the page answers it with that same query.
 */
export const Route = createFileRoute("/_authed/oauth/consent")({
  validateSearch: z.looseObject({ client_id: z.string(), scope: z.string().default("") }),
  loader: ({ context, location }) => {
    const clientId = new URLSearchParams(location.searchStr).get("client_id") ?? "";
    return Promise.all([
      context.queryClient.prefetchQuery(oauthClientQuery(clientId)),
      context.queryClient.prefetchQuery(workspacesQuery()),
    ]);
  },
  component: function OAuthConsent() {
    const { client_id, scope } = Route.useSearch();
    return <Consent clientId={client_id} scope={scope} />;
  },
});
