import { createFileRoute, notFound } from "@tanstack/react-router";
import { LinkFrame } from "../../components/storage/link-frame.tsx";
import { SignPage } from "../../components/storage/sign-page.tsx";
import { ApiError } from "../../lib/api.ts";
import { signingQuery } from "../../lib/storage-signing.ts";

export const Route = createFileRoute("/_authed/sign/$requestId")({
  loader: async ({ context, params }) => {
    try {
      await context.queryClient.ensureQueryData(signingQuery(params.requestId));
    } catch (error) {
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
