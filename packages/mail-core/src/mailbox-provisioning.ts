/** How the mailbox logs in: on a host Omni operates (`purelymail`), or an existing IMAP login. */
export type MailboxLoginProvider = "purelymail" | "imap";

export interface MailboxProvisionFacts {
  domain: string;
  provider: MailboxLoginProvider;
  /** The org's claim on `domain`, or null when it has none. */
  claim: { provider: string; addedAt: Date | null } | null;
  /** A mail host (the Purelymail API) is configured on this deployment. */
  hostConfigured: boolean;
  /** The org's mailbox at this address already, of any provider. */
  existing: { id: string; provider: string } | null;
}

export type MailboxProvisionPlan =
  | { kind: "refuse"; message: string }
  | { kind: "reuse"; mailboxId: string }
  | { kind: "create"; mailboxId: string | null; sameLoginCheck: string | null };

export function planMailboxProvision(facts: MailboxProvisionFacts) {
  const { domain, provider, claim, existing } = facts;
  if (!claim)
    return refuse(`${domain} is not set up for this workspace`) satisfies MailboxProvisionPlan;
  if (claim.provider !== provider)
    return refuse(`${domain} is set up for ${claim.provider}`) satisfies MailboxProvisionPlan;
  if (provider === "purelymail") {
    if (!facts.hostConfigured)
      return refuse("Purelymail is not configured here") satisfies MailboxProvisionPlan;
    if (!claim.addedAt)
      return refuse(
        `${domain} is not on Purelymail yet: add its ownership record`,
      ) satisfies MailboxProvisionPlan;
    if (existing?.provider === "purelymail")
      return { kind: "reuse", mailboxId: existing.id } satisfies MailboxProvisionPlan;
    return {
      kind: "create",
      mailboxId: existing?.id ?? null,
      sameLoginCheck: null,
    } satisfies MailboxProvisionPlan;
  }
  return {
    kind: "create",
    mailboxId: existing?.id ?? null,
    sameLoginCheck: existing?.provider === "imap" ? existing.id : null,
  } satisfies MailboxProvisionPlan;
}

const refuse: (message: string) => MailboxProvisionPlan = (message) => {
  return { kind: "refuse", message };
};
