# Adding a mail domain (Purelymail)

People's mail is sent and received through the mail host (Purelymail for us), never through
Cloudflare: replies must leave from the person's own mailbox, signed with the domain's DKIM key,
with a copy in Sent. Source for every value below: https://purelymail.com/docs/domainDocs.

## Records

| Type  | Name                     | Value                                     | Notes                          |
| ----- | ------------------------ | ----------------------------------------- | ------------------------------ |
| TXT   | `@`                      | per-account ownership value               | Shown in Purelymail → Domains. |
| MX    | `@`                      | `mailserver.purelymail.com`, priority 50  | Remove every other MX.         |
| TXT   | `@`                      | `v=spf1 include:_spf.purelymail.com ~all` | Replace the old SPF; one only. |
| CNAME | `purelymail1._domainkey` | `key1.dkimroot.purelymail.com`            | DNS only (not proxied).        |
| CNAME | `purelymail2._domainkey` | `key2.dkimroot.purelymail.com`            | DNS only.                      |
| CNAME | `purelymail3._domainkey` | `key3.dkimroot.purelymail.com`            | DNS only.                      |
| CNAME | `_dmarc`                 | `dmarcroot.purelymail.com`                | Replaces any `_dmarc` TXT.     |

For a subdomain, the DKIM names become `purelymailN._domainkey.<subdomain>`.

## Steps

1. Purelymail → Domains → add the domain. Copy the ownership TXT value.
2. Cloudflare (account Handle) → the zone → add the records above (`cf dns records create`).
3. Purelymail → Domains → verify. Propagation is usually minutes.
4. Check from outside: `dig +short MX <domain>`, `dig +short TXT <domain>`,
   `dig +short CNAME purelymail1._domainkey.<domain>`.
5. Create users (one per person, one per shared inbox such as `hello@`) and one **app password**
   per user for Omni. Add each to Omni with `pnpm --filter @omni/mail mailbox:add`.
6. Send a test to and from the new address; check the received message's headers for
   `dkim=pass`, `spf=pass`, `dmarc=pass`.

## Domains that already have mail (Google Workspace, iCloud)

Copy the history first, switch DNS second:

1. Add the domain and users in Purelymail (steps 1, 5), but leave the MX where it is.
2. Import existing mail with Purelymail's mail transfer tool (rate-limited: about one job an hour)
   or an IMAP copy.
3. Lower the MX TTL a day ahead, then switch MX, SPF, DKIM, and DMARC in one change.
4. Run a final incremental import to catch mail that arrived during the switch.
5. Keep the old provider active for a week before cancelling it.

## Status

| Domain              | Today            | State                                                                          |
| ------------------- | ---------------- | ------------------------------------------------------------------------------ |
| omnidirectional.app | no mail          | MX, SPF, DKIM, DMARC added 2026-10-31; ownership TXT and verification pending. |
| handlemotion.com    | Google Workspace | not started                                                                    |
| chowmein.tv         | Google Workspace | not started                                                                    |
| ortizortega.com     | iCloud           | not started                                                                    |
| ladmetraje.com      | iCloud           | not started                                                                    |

## Limits to remember

- External sending: about 3,000 messages a day, 300 at once, per account.
- IMAP: `imap.purelymail.com:993` (TLS). SMTP: `smtp.purelymail.com:465` (TLS) or `587` STARTTLS.
- Purelymail documents IDLE support but no limit on simultaneous connections; M0 measures it.
