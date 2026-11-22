import { useState } from "react";
import { IconTrash } from "@/components/icons/central";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { appToast } from "@/components/ui/toast";
import { useClipboard } from "@/hooks/use-clipboard.ts";
import { useBookingLinks, useBookingLinkWrites } from "@/hooks/use-booking.ts";
import { bookingUrl, type BookingLink } from "@/lib/booking.ts";
import type { CalendarItem } from "@/lib/calendar.ts";
import { BookingDialog, bookingFailed } from "./booking-dialog.tsx";

const shortUrl = (slug: string) => bookingUrl(slug).replace(/^https?:\/\//, "");

function LinkRow(props: { link: BookingLink; onCopy: () => void; onDelete: () => void }) {
  const { link } = props;
  return (
    <div className="group/link flex items-center gap-1">
      <Button
        intent="plain"
        className="h-auto min-w-0 flex-1 justify-start gap-3 px-2 py-1.5 text-start"
        onPress={props.onCopy}
        aria-label={`Copy link to ${link.title}`}
      >
        <Avatar isSquare size="md" initials={link.title.slice(0, 1).toUpperCase()} />
        <span className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate text-foreground">{link.title}</span>
            <span className="shrink-0 text-muted-foreground tabular-nums">
              · {link.durationMinutes} min
            </span>
          </span>
          <span className="truncate text-muted-foreground">{shortUrl(link.slug)}</span>
        </span>
      </Button>
      <Button
        intent="plain"
        size="sq-xs"
        aria-label={`Delete ${link.title}`}
        className="opacity-0 group-focus-within/link:opacity-100 group-hover/link:opacity-100"
        onPress={props.onDelete}
      >
        <IconTrash />
      </Button>
    </div>
  );
}

/**
 * The calendar header's Share: the member's booking links, each a public page where someone
 * books a free slot without seeing what fills the rest. A row copies its link.
 */
export function BookingShare(props: { calendars: readonly CalendarItem[] }) {
  const links = useBookingLinks();
  const { create, remove } = useBookingLinkWrites();
  const { copy } = useClipboard();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const copyLink = async (link: BookingLink) => {
    if (await copy(bookingUrl(link.slug))) appToast.success("Link copied");
  };
  return (
    <>
      <PopoverTrigger isOpen={open} onOpenChange={setOpen}>
        <Button size="sm" intent="primary" isDisabled={props.calendars.length === 0}>
          Share
        </Button>
        <Popover
          placement="bottom end"
          collisionPadding={8}
          className="w-88 max-w-[calc(100vw-16px)] gap-1.5 bg-background p-1.5"
        >
          <span className="px-2 pt-1.5 pb-0.5 font-medium text-foreground">Share links</span>
          {(links.data ?? []).length > 0 && (
            <div className="flex flex-col gap-0.5">
              {(links.data ?? []).map((link) => (
                <LinkRow
                  key={link.id}
                  link={link}
                  onCopy={() => void copyLink(link)}
                  onDelete={() =>
                    remove.mutate(link.id, {
                      onError: () => appToast.error("The link was not deleted"),
                    })
                  }
                />
              ))}
            </div>
          )}
          <Button
            intent="primary"
            className="w-full"
            onPress={() => {
              setOpen(false);
              setCreating(true);
            }}
          >
            Create link
          </Button>
        </Popover>
      </PopoverTrigger>
      {creating && (
        <BookingDialog
          calendars={props.calendars}
          saving={create.isPending}
          onClose={() => setCreating(false)}
          onCreate={(json, done) =>
            create.mutate(json, {
              onSuccess: ({ link }) => {
                done(link);
                void copyLink(link);
                setOpen(true);
              },
              onError: bookingFailed,
            })
          }
        />
      )}
    </>
  );
}
