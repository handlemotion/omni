# 0051: People triage with Later and Done; the AI sorts into lanes

Date: 2026-11-19 · Status: accepted · Amends: spec v1 "Clients" (iOS triage lanes, swipe to snooze)

## Context

The spec says the iOS app has "the same triage lanes, swipe to archive or snooze". By the time
the app shipped to TestFlight it had grown several overlapping ways to put a thread aside:

- Needs reply and Awaiting reply pages in the menu, built on the AI lanes.
- A Lane button and sheet on every conversation (Needs reply, Awaiting reply, FYI, Noise).
- A Later sheet with times (Later today, Tomorrow, Next week) that called the timed
  `POST /threads/:id/defer`, which ADR 0027 replaced with an untimed Later.
- On shared inboxes, a Status button and sheet with Open, Resolve and two more snoozes.

Rodrigo wants the app to triage with two actions, Later and Done, and nothing else.

## Decision

1. **iOS triage is Later and Done.** A row swipes right for Done and left for Later; the
   conversation's bar and the row's menu offer the same two. Later is one tap, with no time
   (`POST`/`DELETE /threads/:id/later`, ADR 0027).
2. **Lanes are the AI's, shown as views.** The AI keeps sorting received and sent mail into
   Needs reply, Awaiting reply and Noise. Needs reply and Awaiting reply are views of the Inbox
   on every app. Nobody files a thread in a lane by hand: the Lane button and its sheet (with FYI)
   are gone from iOS.
3. **Shared inboxes keep Open and Resolved, without Snooze.** The Status sheet offers Reopen
   and Resolve only; its two snoozes are gone, since Later covers putting a thread aside. A
   shared-inbox conversation keeps status, assignee, priority and tags, which only shared inboxes
   have; a personal thread shows no tags.
4. **This PR is the iOS client.** Removing FYI, the helpdesk status and timed defer from the
   API, the AI and the web follows in stacked PRs.

## Consequences

- Nobody can snooze a shared conversation from iOS. Conversations snoozed earlier still wake on
  time, and the web's Snooze goes in the next layer.
