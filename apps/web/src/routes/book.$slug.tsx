import { createFileRoute, notFound } from "@tanstack/react-router";
import { BookingPage } from "../components/calendar/booking-page.tsx";
import { EmptyState } from "../components/empty/empty-state.tsx";
import { ApiError } from "../lib/api.ts";
import { bookingPageQuery } from "../lib/booking.ts";

/** A booking link's public page (`docs/spec/calendar.md`, "Booking links"): no sign-in. */
export const Route = createFileRoute("/book/$slug")({
  loader: async ({ context, params }) => {
    try {
      await context.queryClient.ensureQueryData(bookingPageQuery(params.slug));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) throw notFound();
      throw error;
    }
  },
  component: Book,
  notFoundComponent: () => (
    <div className="flex min-h-svh items-center justify-center bg-background">
      <EmptyState figure="loupe" title="Not found" />
    </div>
  ),
});

function Book() {
  const { slug } = Route.useParams();
  return <BookingPage slug={slug} />;
}
