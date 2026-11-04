// Adds a card to the workspace with a SetupIntent the browser confirms (transitive's add-card
// dialog, on Omni's dialog and tokens). The number is typed into Stripe's own frame and goes to
// Stripe; Omni only ever learns the saved card's brand, last four and expiry.
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
// `pure`: Stripe.js loads when the dialog first opens, not on every page of the app.
import { loadStripe } from "@stripe/stripe-js/pure";
import type { Appearance, Stripe } from "@stripe/stripe-js";
import { type FormEvent, useEffect, useState } from "react";
import { Skeleton } from "skullet/react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { TextField } from "@/components/ui/text-field";
import { appToast } from "@/components/ui/toast";
import { useCardAdded, useCardSetup } from "@/hooks/use-billing.ts";

// One Stripe.js per key for the page's lifetime, as Stripe recommends.
const instances = new Map<string, Promise<Stripe | null>>();
function stripeFor(publishableKey: string) {
  let instance = instances.get(publishableKey);
  if (!instance) {
    instance = loadStripe(publishableKey);
    instances.set(publishableKey, instance);
  }
  return instance;
}

/** Stripe's fields drawn in our tokens, read from the page so they follow `styles.css`. */
function appearance(): Appearance {
  const token = (name: string) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return {
    theme: "stripe",
    variables: {
      colorPrimary: token("--ring"),
      colorBackground: token("--background"),
      colorText: token("--foreground"),
      colorTextSecondary: token("--muted-foreground"),
      colorDanger: token("--danger"),
      fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      fontSizeBase: "13px",
      borderRadius: "6px",
    },
    rules: {
      ".Input": { borderColor: token("--border"), boxShadow: "none" },
      ".Input:focus": { borderColor: token("--ring"), boxShadow: "none" },
      ".Label": { color: token("--foreground") },
    },
  };
}

type Setup =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; clientSecret: string; stripe: Promise<Stripe | null> };

/** Mounted while open: each opening asks for a fresh SetupIntent. */
export function BillingAddCardDialog({ onClose }: { onClose: () => void }) {
  const setupCard = useCardSetup();
  const [setup, setSetup] = useState<Setup>({ status: "loading" });
  const [saving, setSaving] = useState(false);
  const { mutateAsync } = setupCard;

  useEffect(() => {
    let current = true;
    mutateAsync()
      .then(({ clientSecret, publishableKey }) => {
        if (current) setSetup({ status: "ready", clientSecret, stripe: stripeFor(publishableKey) });
      })
      .catch(() => current && setSetup({ status: "failed" }));
    return () => {
      current = false;
    };
  }, [mutateAsync]);

  return (
    <Dialog
      size="sm"
      isOpen
      onOpenChange={(open) => !open && !saving && onClose()}
      closeButton={!saving}
    >
      <DialogHeader>
        <DialogTitle>Add card</DialogTitle>
        <DialogDescription>The plan is charged to the default card.</DialogDescription>
      </DialogHeader>
      {setup.status === "ready" ? (
        <Elements
          stripe={setup.stripe}
          options={{ clientSecret: setup.clientSecret, appearance: appearance() }}
        >
          <AddCardForm saving={saving} onSavingChange={setSaving} onSaved={onClose} />
        </Elements>
      ) : setup.status === "failed" ? (
        <>
          <DialogBody>
            <p className="text-sm text-muted-foreground">
              A card can't be added right now. Try again in a moment.
            </p>
          </DialogBody>
          <DialogFooter>
            <DialogClose intent="outline">Close</DialogClose>
          </DialogFooter>
        </>
      ) : (
        <Skeleton id="settings-billing-add-card" loading label="Preparing the card form">
          <SampleForm />
        </Skeleton>
      )}
    </Dialog>
  );
}

/** The card form's shape, drawn as a skeleton while Stripe's fields are on their way. */
function SampleForm() {
  return (
    <>
      <DialogBody className="gap-3">
        <TextField isDisabled>
          <Label>Card number</Label>
          <Input />
        </TextField>
        <div className="grid grid-cols-2 gap-3">
          <TextField isDisabled>
            <Label>Expiration date</Label>
            <Input />
          </TextField>
          <TextField isDisabled>
            <Label>Security code</Label>
            <Input />
          </TextField>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button intent="outline" isDisabled>
          Cancel
        </Button>
        <Button isDisabled>Save card</Button>
      </DialogFooter>
    </>
  );
}

function AddCardForm({
  onSaved,
  onSavingChange,
  saving,
}: {
  onSaved: () => void;
  onSavingChange: (saving: boolean) => void;
  saving: boolean;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const added = useCardAdded();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!stripe || !elements) return;
    setError(null);
    onSavingChange(true);
    // A card that asks for 3-D Secure opens Stripe's challenge in place; no page redirect.
    const result = await stripe.confirmSetup({
      elements,
      redirect: "if_required",
      confirmParams: { return_url: window.location.href },
    });
    if (result.error) {
      onSavingChange(false);
      setError(result.error.message ?? "That card couldn't be saved. Try again.");
      return;
    }
    added.mutate(result.setupIntent.id, {
      onSuccess: () => {
        appToast.success("Card added.");
        onSaved();
      },
      onError: (failure) => setError(failure.message || "That card couldn't be saved."),
      onSettled: () => onSavingChange(false),
    });
  }

  return (
    <form className="flex min-h-0 flex-col gap-4" onSubmit={(event) => void submit(event)}>
      <DialogBody className="gap-3">
        <PaymentElement
          onReady={() => setReady(true)}
          // Stripe.js could not start (a wrong key, Stripe unreachable): say so instead of an
          // empty dialog.
          onLoadError={() => setError("A card can't be added right now. Try again in a moment.")}
          options={{
            layout: "tabs",
            // The app's Permissions-Policy turns off the Payment Request API, and Link (Stripe's
            // consumer wallet) has no place in a workspace's billing.
            wallets: { applePay: "never", googlePay: "never", link: "never" },
          }}
        />
        {error && (
          <p className="text-xs/4 text-danger" role="alert">
            {error}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <DialogClose intent="outline" isDisabled={saving}>
          Cancel
        </DialogClose>
        <Button type="submit" isDisabled={!stripe || !elements || !ready} isPending={saving}>
          Save card
        </Button>
      </DialogFooter>
    </form>
  );
}
