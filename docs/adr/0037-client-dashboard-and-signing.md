# 0037: A client dashboard on the deal, and native contract signing

Date: 2026-11-16 · Status: proposed (direction set, not scheduled) · Builds on: ADR 0034,
ADR 0036

## Context

The founder wants a company's clients to sign in and see their project: get the deliverables,
sign the contract, and more later. This comes after CRM v1. It is written down now for one
reason: so nothing in ADR 0036 has to be undone to build it. The founder chose the signing
direction on Nov 16, 2026: **built into Omni, a simple electronic signature**, with room for a
stronger one later.

Three things ADR 0034 and ADR 0036 already built carry most of it:

- Storage shares by address with people outside Omni, who sign in with that address
  (ADR 0034 decision 4). A client is exactly that kind of person.
- A won deal is the project (ADR 0036), with a folder in Shared and contracts whose files can
  be locked.
- `forUser` already has a per-module door for what was shared with a person's verified
  addresses, and it already respects session scope (ADR 0024).

This ADR becomes `accepted`, with its details checked again, when the work is scheduled.

## Decision

### 1. A client is a guest of a deal, by address

- New table `crm_deal_guests` (id, org_id, deal_id, email, role, invited_by_member_id,
  created_at), unique on (deal_id, email). Like a Storage grant, the guest is an address, not a
  user, so it can exist before the person does.
- Adding a guest sends one system mail with the dashboard link (ADR 0020). The person signs in
  with that address by magic link, which makes their account and Personal space as sign-up
  already does (ADR 0018, ADR 0024). Where `SIGN_UP=invitation`, a guest must already be able
  to sign in, as for Storage grants.
- Removing a guest is immediate: every request checks the row.

### 2. The guest door shows a projection, never the record

`db.forUser(userId, scope).crm` (ADR 0036 decision 3) opens deals that have a guest row for an
address the person has verified. Session scope applies exactly as for Storage grants (ADR 0034
decision 3).

A guest gets a fixed list of fields, written in the door, never the CRM row:

| A guest sees                                             | A guest never sees                             |
| -------------------------------------------------------- | ---------------------------------------------- |
| The deal's name, the company's name and logo             | The value, the owner, internal stage names     |
| Its status, from the stage **kind** (running, delivered) | Notes, events, the timeline, any email         |
| Files in the deal's `Client` folder                      | The rest of the deal's folder                  |
| Contracts sent to them, and their signing state          | Draft contracts, other clients, other deals    |
| Updates a member published to the client                 | Anything about other guests beyond their names |

A new field reaches clients only by being added to that list.

### 3. Deliverables are the `Client` folder

A deal's folder gains a subfolder, `Client`, made when the first guest is added. Adding a guest
writes a Storage grant for their address on that subfolder (viewer, or editor so they can send
material back), through Storage's sharing operations. Delivering something is putting a file
there. Everything Storage does for a grant (listing, download, removal, session scope) applies
unchanged, and CRM serves no bytes.

Tracked deliverables (a title, a due date, an approval by the client) are a later table,
`crm_deliverables`, that points at nodes in that folder.

### 4. Signing is native and simple, and every step leaves evidence

A contract (ADR 0036 decision 6) gains signers and an audit trail:

- `crm_contract_signers` (contract_id, email, name, role `client` | `company`, signed_at,
  typed_name, document_sha256, ip, user_agent, user_id).
- `crm_signature_events`: append-only (sent, viewed, code_sent, code_verified, signed,
  completed, voided), each with time, address, IP and user agent.

The flow:

1. **Send.** A member names the signers and sends. The document must be a PDF. It is locked
   (ADR 0036 decision 6) and its SHA-256 is computed by streaming it through the Worker and
   stored. The file that is signed is the file that was sent; changing it means voiding and
   sending a new contract.
2. **Prove who signs.** A signer is signed in with a session that verified the signer's
   address, and enters a one-time code mailed to that address at the moment of signing. An old
   session alone signs nothing.
3. **Sign.** The signer reads the document, accepts a fixed consent sentence (its text and
   version are stored) and types their name. The row records the hash they signed.
4. **Seal.** When every signer has signed, the Worker appends an audit page to the PDF (each
   signer, address, time in UTC, IP, the original's hash, the contract id), stores the result
   beside the original as a locked file, records its hash, sets the contract `signed`, and
   mails every party a copy. The step is keyed by the contract, so a retry seals once.

- **What this is:** a simple electronic signature. The evidence is control of a mailbox at
  signing time, a typed name with consent, and a document whose hash is recorded before and
  after.
- **What this is not:** an advanced or qualified signature. There is no certificate per signer
  and no identity check beyond the mailbox.
- **Room for a stronger one.** A sealed contract has a `conservation` slot (provider,
  timestamp, certificate). It can hold a trusted timestamp from an RFC 3161 authority, or in
  Mexico a NOM-151-SCFI-2016 conservation certificate from an accredited provider, without
  changing the flow. A signing provider could also fill `signed` and attach the executed copy,
  which is all v1 of contracts needs (ADR 0036).
- Self-hosting: signing needs no outside service. The timestamp authority is optional config.

### 5. Where it lives

The same web app and the same sign-in. A person who is a guest and not a member lands on their
dashboard, the way Storage's "Shared with me" already works for them. It is not a second
product with its own accounts.

## To confirm before this is accepted

From primary sources or a professional, not assumed here:

- **The legal standing, with a lawyer.** That a simple electronic signature with this evidence
  is acceptable for the service contracts we and our customers sign, in Mexico first (Código
  de Comercio, arts. 89 to 114) and wherever customers are. Which documents need more. The
  consent sentence itself.
- Whether a NOM-151 certificate or an RFC 3161 timestamp should be in the first version or the
  slot is enough.
- That a PDF library runs in workerd within its CPU and memory limits for the file sizes we
  allow (`pdf-lib` is the candidate), and what that size cap is.
- How long evidence is kept after a workspace is deleted, and what a signer may ask us to
  delete.

## Open, for the founder when it is scheduled

- The dashboard's address and branding: on Omni's origin, or the company's own domain and logo.
- What else a client does there: approve deliverables, pay an invoice (Stripe), write to the
  team (a shared-inbox conversation per project is the natural fit).
- Whether guests count toward anything on the plan. Today nothing in Omni is priced per person.

## Consequences

- CRM v1 needs nothing extra for this, by design: guests are addresses, deliverables are a
  folder, contracts already have a status and a lock, and stage kinds already say "running" and
  "delivered" without exposing a stage's name.
- Signed contracts make Omni hold legal evidence. Backups, retention and deletion requests
  become obligations, not housekeeping.
- A second kind of outsider can now sign up (a client), after Storage's grantees. Abandoned
  sign-up cleanup (ADR 0018) must keep an account that is a guest.
- Mail that asks someone to sign is a phishing pattern. Signing mail goes through the system
  mail path with its limits, names the sending company plainly, and links only to Omni's
  origin.
