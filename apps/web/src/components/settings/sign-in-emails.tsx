import { EllipsisHorizontalIcon } from "@heroicons/react/20/solid";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Menu, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { TextField } from "@/components/ui/text-field";
import { appToast } from "@/components/ui/toast";
import {
  useAddSignInEmail,
  useRemoveSignInEmail,
  useSetPrimarySignInEmail,
  useSignInEmails,
} from "@/hooks/use-sign-in-emails.ts";

/** Rows of the same kind share one rhythm: 8px above and below the 20px line (a 36px row, the
 *  height of the `sq-xs` menu button plus room), and the list keeps the card's 24px sides. */
const ROW = "flex min-h-10 items-center justify-between gap-4 py-2";

const failed = (error: Error) => appToast.error(error.message);

// Not from a Figma frame yet: a first pass from the primitives, for the designer to replace.
/** The addresses this person signs in with. Each extra one is confirmed by a mailed link. */
export function SignInEmails() {
  const emails = useSignInEmails();
  const add = useAddSignInEmail();
  const setPrimary = useSetPrimarySignInEmail();
  const remove = useRemoveSignInEmail();
  const [email, setEmail] = useState("");

  return (
    <Card>
      <CardHeader title="Sign-in emails" />
      <CardContent className="flex flex-col gap-4">
        {/* The first row's own 8px top padding would add to the card's 24px gap under the
            title; pulled back so the title keeps one 24px gap to the first address. */}
        <ul className="-mt-2 flex flex-col">
          {emails.data?.emails.map((row) => (
            <li key={row.email} className={ROW}>
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm/5">{row.email}</span>
                {row.primary && <Badge intent="secondary">Primary</Badge>}
              </span>
              {!row.primary && (
                <MenuTrigger>
                  {/* The glyph's ink sits ~6px inside its 26px button: pulled out so its right edge
                      keeps the card's 24px, as the addresses do on the left. */}
                  <Button
                    intent="plain"
                    size="sq-xs"
                    className="-me-1.5"
                    aria-label={`Options for ${row.email}`}
                  >
                    <EllipsisHorizontalIcon />
                  </Button>
                  <Menu placement="bottom end" className="p-1">
                    <MenuItem
                      onAction={() =>
                        setPrimary.mutate(row.email, {
                          onSuccess: () => appToast.success(`${row.email} is now primary`),
                          onError: failed,
                        })
                      }
                    >
                      Make primary
                    </MenuItem>
                    <MenuItem
                      intent="danger"
                      onAction={() => remove.mutate(row.email, { onError: failed })}
                    >
                      Stop signing in with it
                    </MenuItem>
                  </Menu>
                </MenuTrigger>
              )}
            </li>
          ))}
        </ul>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            add.mutate(email, {
              onSuccess: (sent) => {
                setEmail("");
                appToast.success(`Link sent to ${sent.email}`, {
                  description: "Open it in this browser to confirm.",
                });
              },
              onError: failed,
            });
          }}
        >
          <TextField
            type="email"
            aria-label="Add a sign-in email"
            isRequired
            value={email}
            onChange={setEmail}
            className="flex-1"
          >
            <Input placeholder="you@example.com" />
          </TextField>
          <Button type="submit" intent="outline" isPending={add.isPending}>
            Add email
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
