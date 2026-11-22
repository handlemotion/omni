import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  bookingLinksQuery,
  bookingPageQuery,
  bookMutation,
  createBookingLinkMutation,
  deleteBookingLinkMutation,
} from "@/lib/booking.ts";

export const useBookingLinks = () => useQuery(bookingLinksQuery());

export function useBookingLinkWrites() {
  const client = useQueryClient();
  return {
    create: useMutation(createBookingLinkMutation(client)),
    remove: useMutation(deleteBookingLinkMutation(client)),
  };
}

export const useBookingPage = (slug: string) => useSuspenseQuery(bookingPageQuery(slug));

export function useBook(slug: string) {
  const client = useQueryClient();
  return useMutation(bookMutation(client, slug));
}
