import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { LinkFrame } from "../components/storage/link-frame.tsx";
import { SignPage } from "../components/storage/sign-page.tsx";
import { ApiError } from "../lib/api.ts";
import { openSigningLink, signingQuery } from "../lib/storage-signing.ts";

const tokenIn = (hash: string) => new URLSearchParams(hash.replace(/^#/, "")).get("t");

/**
 * The page a signer lands on. The mail's link carries a token after `#`, never sent to a server
 * by the browser: it is traded for a cookie on this one request, then dropped from the address.
 * Without one, the signed-in person opens it by their addresses.
 */
export const Route = createFileRoute("/sign/$requestId")({
  beforeLoad: async ({ params }) => {
    const token = typeof window === "undefined" ? null : tokenIn(window.location.hash);
    if (!token) return;
    await openSigningLink(params.requestId, token).catch((error: unknown) => {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    });
    window.history.replaceState(window.history.state, "", window.location.pathname);
  },
  loader: async ({ context, params, location }) => {
    try {
      await context.queryClient.ensureQueryData(signingQuery(params.requestId));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        throw redirect({ to: "/login", search: { redirect: location.href } });
      }
      if (error instanceof ApiError && error.status === 404) throw notFound();
      throw error;
    }
  },
  component: Sign,
  notFoundComponent: () => (
    <LinkFrame>
      <p className="p-5 text-sm text-foreground">Not found.</p>
    </LinkFrame>
  ),
});

function Sign() {
  const { requestId } = Route.useParams();
  return (
    <LinkFrame>
      <SignPage requestId={requestId} />
    </LinkFrame>
  );
}
