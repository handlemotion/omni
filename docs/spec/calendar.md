# Omni Calendar: meetings beside the mail they came in

Nov 22, 2026 · Draft for review · Extends `docs/spec/v1.md` and `docs/spec/modules.md`

## Summary

Omni gets a calendar in the spirit of Cron (now Notion Calendar) and Amie: a fast week view you
drive from the keyboard, several calendars laid over each other, and availability you can send
someone. It is small on purpose. What makes it worth having beside Google Calendar is where it
sits: next to the mail, the clients and the files a meeting is about.

- An invitation that arrives by mail is on the calendar by itself, and Yes, No and Maybe answer it
  from the thread.
- A meeting shows who is in it as CRM people, companies and deals, and the thread it came from.
  A deal shows its past and upcoming meetings.
- A meeting's notes are an Omni doc in Drive, one per meeting for the whole workspace.
- Agents read the calendar and propose times.

The first version needs no new service, no new credential and no new variable. Events come from
the invitations the mail service already stores (iCalendar over email, iMIP), and invitations Omni
sends go out through the mail outbox. CalDAV, Google and Microsoft calendars come later, behind
the mailbox's provider. Meeting recording and transcription are specified below and not built in
this stack.

## Goals and non-goals

**Goals**

- Week and day views, fast, with creating, moving and answering an event done from the keyboard.
- Every calendar a person can see, overlaid, each with its own color and a toggle.
- Invitations from any calendar app (Google, Outlook, Apple, Fastmail, Zoho, Proton) show on the
  calendar and inline in the thread, with an answer that reaches the organizer's calendar.
- Events made in Omni invite people on any calendar app, by mail.
- A link and a block of text that share free time, never what fills the rest.
- A meeting's people are CRM records; a deal lists its meetings; notes are a Drive doc.
- Agents read events and propose times through MCP.
- Works on any IMAP/SMTP host. Self-hostable with no new required config.

**Non-goals for this version** (each is additive later)

- Two-way sync with the host's own calendar (CalDAV), Google Calendar or Microsoft 365.
- Repeating events made in Omni. Repeating invitations from elsewhere are shown in full.
- Booking pages where a visitor picks a slot. The shared link shows free time only.
- Reminders and notifications before a meeting, tasks on the calendar, travel time.
- Rooms and resources, delegated calendars, a teammate's calendar beyond the inboxes you share.
- Meeting recording and transcription (specified in "Recording, later").
- The iOS app.

## What we take from Cron and Amie

| Pattern                                   | In v1                                                          | Later                                        |
| ----------------------------------------- | -------------------------------------------------------------- | -------------------------------------------- |
| Keyboard first                            | Create, open, move, delete, answer and navigate without a mouse | A command bar that parses "lunch with Ana fri 1pm" |
| Several calendars at once                 | One per inbox you can open, overlaid, each toggled and colored  | CalDAV, Google and Microsoft calendars        |
| Share availability                        | Copy free slots as text; a link that shows free and busy        | Booking: the visitor picks a slot            |
| Join from the event                       | The video link pulled from the invitation, one key to join      | Joining from a notification                  |
| Meeting context                           | People as CRM records, the email thread, the notes doc          | The last threads with each person            |
| Time zones                                | The viewer's own; the event keeps its zone                      | A second zone in the gutter                  |
| Notes (Amie)                              | One Omni doc per meeting in Drive                               | A template per kind of meeting               |
| Recording (Amie, Granola)                 | Spec only                                                       | Botless capture, cheap transcription         |

No feature sprawl: no month view in v1 (Cron shipped without one for a year), no tasks on the
calendar, no scheduling AI beyond the agent tools.

## Where events come from

Omni runs on IMAP/SMTP at Purelymail or any host, and only `apps/mail` speaks to the host. Four
sources were weighed.

| Source                              | What it gives                                                   | Cost to us                                                                      | When  |
| ----------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----- |
| **Invitations in mail (iMIP)**      | Every meeting someone invites an inbox to, from any calendar app | None new. The mail service already stores each `text/calendar` part             | v1    |
| **Events made in Omni**             | Your own events, and invitations you send                        | Postgres rows; invitations go out through the existing outbox                   | v1    |
| CalDAV on the mail host             | The host's own calendars, synced both ways with Apple Calendar   | A DAV client in `apps/mail`, per-host quirks; Purelymail implements the basic RFC only | Later |
| Google and Microsoft calendar APIs  | Full calendars of connected accounts                              | A new OAuth scope with Google's verification; a Microsoft connection mail lacks | Later |

**Why mail first.** iMIP (RFC 6047) is how every calendar app invites someone on another one: the
invitation is an email with a `text/calendar` part (`METHOD:REQUEST`), an answer is an email back
(`METHOD:REPLY`), a cancellation is a third (`METHOD:CANCEL`). The mail service already turns that
part into an attachment row and an object in R2 (`fixtures/eml/calendar-invite-outlook.eml`
parses to one `text/calendar` attachment), so the calendar reads what mail has, through mail's
door. It works on every IMAP host, needs no password the mail service does not already hold, and
keeps v1's rule: Postgres is an index the host can rebuild. Wipe the calendar's tables and the next
sweep derives the same events from the same messages.

The meetings that matter to Omni are the ones with other people in them: a client call, a deal's
kickoff. Those are exactly the ones that travel by mail.

**What v1 does not see.** An event someone puts straight into Google Calendar or Apple Calendar
with nobody invited, and a meeting a person organized in another app (the invitation leaves from
that app, not from their mailbox, so it is not in Sent). Both come with the second source of each
account: CalDAV for the mail host, the calendar API for a connected Google account.

**Why CalDAV is next and not first.** `docs/spec/modules.md` names CalDAV as the base, used the way
mail uses IMAP. It still is the right way to sync the host's own calendar, and it lives in
`apps/mail` beside IMAP. But Purelymail implements the basic RFC (4791) and not every extension
sync needs (`sync-collection`, RFC 6578), so it starts with a spike against Purelymail, behind the
mailbox's `provider`, and is optional on other hosts. Events from CalDAV are one more source for
the same tables (`source = 'caldav'`).

**Google and Microsoft** come with the SaaS path in `v1.md`. A Google account already connects
for mail (`provider = 'gmail'`); its calendar needs the `calendar.events` scope, a sensitive scope
that requires Google's app verification, and a self-hoster needs their own Google app for it. It
is optional config on top of the `GOOGLE_*` variables a self-hoster already sets for Gmail.

**Rejected:** subscribing to arbitrary ICS URLs (`webcal://`) from the Worker. Fetching any URL a
person pastes is the server-side request forgery problem `docs/spec/mcp.md` declines for CIMD.
If it comes, it comes through the mail service, which can pin a resolved address.

## Objects

- **Calendar.** One per inbox, made the first time it is needed. Who sees it is who sees the
  inbox (`mailbox_access`): a personal inbox's calendar is its owner's, `hello@`'s is everyone
  on `hello@`. Each person picks its color and whether it shows, for themselves only.
- **Event.** A title, a time (a start and end instant, or a start and end day for an all-day
  event), its time zone, a location, a video link, a description, a status (`confirmed`,
  `tentative`, `cancelled`), whether it counts as busy, the organizer, the attendees with their
  answers, and the iCalendar identity it was sent with (`UID`, `SEQUENCE`, `DTSTAMP`, and
  `RECURRENCE-ID` for one changed instance of a repeating event). It comes from an invitation
  (`source = 'invite'`) or was made in Omni (`'omni'`).
- **Attendee.** An address, a name, a role (`chair`, `required`, `optional`, `none`) and an
  answer (`needs_action`, `accepted`, `declined`, `tentative`). The inbox's own address among them
  is "me": its answer is the calendar's answer.
- **Availability link.** A person's link that shows free and busy for the next days over the
  calendars they chose, in a time zone and working hours they set. It can be turned off.
- **Notes.** At most one Omni doc per meeting per workspace, wherever it lives in Drive.

The same meeting sent to `ana@` and `hello@` is two events, one on each calendar, as a message
sent to both is stored once per mailbox. They share one notes doc, found by `(org, UID, instance)`.

## How people use it

**Open the calendar.** `/calendar` opens the week, from Monday, in the browser's time zone, at the
current hour. Every calendar the person can see in the active workspace is overlaid; the sidebar
lists them with a color dot to toggle each. All-day events sit in a strip above the hours.
Overlapping events share the column side by side. A declined event is drawn faint, a tentative one
hatched, an unanswered invitation outlined.

**Keys.** Everything a mouse does, a key does too. The calendar takes no key while a field has
focus.

| Key                     | Does                                                                     |
| ----------------------- | ------------------------------------------------------------------------ |
| `c`                     | New event at the selected slot (or the next half hour), title focused    |
| `←` `→` / `j` `k`       | Previous or next week (day in day view)                                  |
| `t`                     | Today                                                                    |
| `w` · `d`               | Week view · day view                                                     |
| `↑` `↓`                 | Move the selected slot by 15 minutes; with an event selected, the event  |
| `Shift` `↑` `↓`         | Make the selection or the selected event 15 minutes longer or shorter     |
| `Tab` · `Shift` `Tab`   | Select the next or previous event                                         |
| `Enter`                 | Open the selected event                                                  |
| `y` · `n` · `m`         | Answer the selected invitation Yes, No, Maybe                            |
| `⌫`                     | Delete the selected event (yours) or decline it (an invitation)          |
| `⌘` `Enter` · `Esc`     | Save · close                                                             |
| `j` in an open event    | Join its video link                                                      |
| `⌘K`                    | The command menu: jump to a day, find an event by title                  |

Dragging in the grid makes an event over the dragged time; dragging an event moves it, and its
bottom edge changes its end.

**Make an event.** A title, the time, guests (addresses, suggested from CRM people and recent
correspondents), a location or video link, a description, and the calendar it goes on, which is
the inbox it is sent from. With guests, Omni sends each an invitation from that inbox; changing
the time or the guests sends an update (`SEQUENCE` goes up); deleting it sends a cancellation.
Answers that come back by mail update each guest's answer on the event.

**Answer an invitation.** In the thread, the invitation shows as a card above its message: title,
when in the viewer's time zone, where, who is invited, any of the viewer's events at the same time,
and Yes, No, Maybe. The same three sit in the event's panel on the calendar. Answering sends the
organizer an iMIP reply from the inbox the invitation reached, and the event takes the answer at
once. An answer can be changed; each change is a new reply.

**Share availability.** From the calendar, "Share availability" picks the days and a meeting
length and copies the free slots as text, the way Cron does:

```
Mon, Nov 23: 10:00–11:30, 14:00–16:00
Tue, Nov 24: 09:00–12:00
(Europe/Madrid)
```

The same menu gives the person's availability link (`<WEB_APP_URL>/availability/<token>`), a
public page with the next 14 days in the visitor's time zone: free and busy only, no titles, no
people, no places. The link reads the calendars and hours its owner chose, can be turned off, and
gets a new token when it is reset. A busy block is any confirmed or tentative event that counts as
busy, an answered Yes or Maybe, or an unanswered invitation; a declined one is free.

## Twined with the other modules

The join keys are the address, the message and the meeting's iCalendar identity. Nothing below
copies another module's rows, and each link is read through the other module's door, so a person
sees nothing they could not open on its own.

| Link                | What a person sees                                                   | How                                                                                                   |
| ------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Mail → Calendar     | Invitations land on the calendar by themselves                        | The calendar reads mail's `text/calendar` attachments through mail's surface                          |
| Mail → Calendar     | An invitation card with Yes, No, Maybe in the thread                  | `GET /api/calendar/invites?thread=`; the card's answer goes through the calendar's route               |
| Calendar → Mail     | An event links the thread it came in                                  | The event keeps its message id; the thread is returned only when mail's door opens it for the viewer   |
| Calendar → Mail     | Invitations, updates and answers go out as mail                       | A `send` action in the outbox with a `calendar` part (see "Sending")                                   |
| Calendar → CRM      | An event lists its attendees as CRM people, companies and deals        | The app calls `GET /api/crm/lookup?address=` with the attendees, as the conversation sidebar does      |
| CRM → Calendar      | A person, company or deal shows its past and upcoming meetings         | Calendar's door gains `meetingsWith`, read through `forUser`, as mail's `threadsWith` is               |
| Calendar → Drive    | "Notes" opens the meeting's Omni doc, made the first time              | Storage's door makes the doc; the deal's teamspace when the meeting is on one deal, else My files      |
| Calendar → agents   | `calendar_events` and `calendar_find_times`                           | MCP tools through the calendar's door, scope `calendar:read`                                           |

- **The calendar uses mail and storage.** It reads mail's attachments, threads and mailboxes,
  and asks Storage to make a doc. It never reads the CRM: the event panel asks the CRM itself,
  so the CRM can read the calendar without a loop.
- **The CRM uses calendar.** `meetingsWith({ addresses, domains, before | after, limit })` gives
  the events on calendars the viewer can see whose attendees or organizer match, with each
  event's calendar and answer. A person's addresses ask for theirs; a company's add its domains;
  a deal's are its people's. The CRM's timeline gains a `meeting` item, and a deal's page a
  Meetings section, upcoming first.
- **A freelancer** sees the meetings of the inboxes they can open, as with mail, on the projects
  the CRM already lets them open; nothing on a CRM page shows them a meeting from an inbox they
  cannot open.
- **Notes.** The panel's Notes makes the doc on the first click and opens it every time after.
  The doc is named `<title> · <day>`, holds the time, the attendees and a heading for notes, and
  is found again by `(org, UID, RECURRENCE-ID)`, so everyone in the workspace invited to the
  meeting opens the same doc. Its access is Drive's: a member who cannot open the place it is in
  sees "Notes" only as a way to ask for it. The app chooses the place and the Worker checks the
  member may write there: the teamspace of the one deal the attendees are on (`#741` gives each
  deal a teamspace), otherwise the member's My files. Drive indexes the doc's text like any other
  file, so `drive_search` finds what was said in a meeting.

## Sending

Omni sends calendar mail through the mail outbox, as every other send.

- `sendPayloadSchema` gains an optional `calendar: { method: "REQUEST" | "REPLY" | "CANCEL",
  ics }`. The mail service hands it to MailComposer's `icalEvent`, which writes the
  `text/calendar; method=…` alternative part and an `invite.ics` attachment every calendar app
  recognizes. The text and HTML bodies say the same thing in words.
- **Expand step.** A mail service from before the field drops it and sends the words alone: the
  organizer reads "Accepted: Kickoff" but their calendar does not update. It is a window of
  minutes on each deploy, Omni's own state is right in both cases, and no new action kind is
  needed (an unknown kind would fail the action instead).
- A reply goes from the inbox the invitation reached, to the organizer, in the invitation's
  thread (`In-Reply-To`), with only the inbox's own attendee line in it.
- An invitation goes from the event's inbox to its guests; the organizer is the inbox's address.
  Each change sends the whole event again with a higher `SEQUENCE`; removing a guest sends them
  a cancellation; deleting the event sends everyone one.
- The idempotency key is the event, its sequence and the method (and the answer for a reply), so
  a retry never sends a second copy and a real change always does.
- The ICS text is built by a pure function in `@omni/mail-core` from the event, tested against
  what Google, Outlook and Apple accept.

## Ingesting invitations

A sweep in the Worker, every minute and right after each arrival, reads mail's calendar
attachments in the order they were stored and applies each to its inbox's calendar. Each part is
recorded (`calendar_parts`) with what it did, so applying one twice changes nothing.

1. Mail's surface lists calendar attachments (`text/calendar`, `application/ics`, or a `.ics`
   name) stored after the sweep's cursor, oldest first, a bounded batch. The cursor trails the
   newest by ten minutes, so an attachment committed late is still read; ones already recorded
   are skipped. A fresh install, or one whose calendar tables were emptied, starts at the oldest
   mail and works forward at a few hundred parts a minute: past meetings fill in by themselves.
2. Calendar apps send the event twice in one message, as the `text/calendar` alternative and as
   an `invite.ics` attachment; both are applied, and the second changes nothing. Parts in Junk or
   Trash only are skipped. Parts over 256 KB, or that do not parse, are recorded
   as `invalid`.
3. The part's VEVENTs are parsed with `ical.js` (Mozilla's, used by Thunderbird) in
   `@omni/mail-core`. Times become UTC instants with the event's zone kept: an IANA `TZID` as is,
   a Windows name (`Romance Standard Time`, which Outlook sends) mapped through CLDR's table
   (`windows-iana`), and a zone known only by its `VTIMEZONE` through that definition.
4. **Which wins.** For an event (`UID`, `RECURRENCE-ID`) the higher `(SEQUENCE, DTSTAMP)` wins; an
   older one is recorded as `stale` and changes nothing. A `CANCEL` at or above the current
   sequence marks it `cancelled` (one instance, or the whole series). For an attendee's answer
   the later `DTSTAMP` wins, between the organizer's `REQUEST` and the attendee's `REPLY`. Each
   answer is kept on its own (`calendar_answers`), so one that arrives before its invitation is
   not lost. So the same mail applied in any order ends in the same state, which is what a
   re-sync needs.
5. **Who may change what.** A `REQUEST` or `CANCEL` for an event the calendar already holds is
   applied only when the message's From is the event's organizer, or the message is in the inbox's
   own Sent folder; a `REPLY` only changes the attendee whose address sent it. Anyone can invite
   an inbox to something new, but not move or cancel someone else's meeting by mailing a `UID`.
6. Repeating events keep their `RRULE`, `EXDATE`s and `RDATE`s and are expanded when read, in the
   event's zone, so a weekly 10:00 in Madrid stays at 10:00 across the change to winter time. A
   changed instance is its own row with its `RECURRENCE-ID`. A read expands at most 1,000
   instances per series and windows of at most 62 days.
7. Every change announces `calendar.changed` to the sockets of the inbox's members.

Our own sends land in Sent with their `text/calendar` part, so the sweep reads them too: events
made in Omni with guests, and our replies, can be rebuilt from mail. An event with no guests sends
nothing and lives in Postgres alone, like a CRM record, under the same backups.

## Data model

Every table is `calendar_*` and carries `org_id`.

| Table                     | Key fields                                                                                                                                                                                                                                                                 | Notes                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `calendar_calendars`      | id, org_id, mailbox_id (unique), created_at                                                                                                                                                                                                                                | One per inbox. Access is the inbox's.                                                     |
| `calendar_events`         | id, org_id, calendar_id, uid, recurrence_id, sequence, dtstamp, source, status, busy, title, description, location, conference_url, starts_at, ends_at, all_day, start_day, end_day, time_zone, rrule, exdates, rdates, recurs_until, organizer_address, organizer_name, message_id, created_by_member_id | Unique on (calendar_id, uid, recurrence_id), nulls not distinct. Indexed on (calendar_id, starts_at) and, for series, (calendar_id, recurs_until). |
| `calendar_attendees`      | event_id, org_id, address, name, role, response, responded_at                                                                                                                                                                                                              | Key (event_id, address). Indexed on (org_id, address) for `meetingsWith`.                  |
| `calendar_answers`        | org_id, calendar_id, uid, recurrence_id, address, response, answered_at                                                                                                                                                                                                    | Each attendee's own answer, kept apart from the event; the later one wins.                |
| `calendar_parts`          | attachment_id, org_id, calendar_id, method, uid, outcome, reason, processed_at                                                                                                                                                                                             | What each part did: `applied`, `stale`, `ignored`, `invalid`. Cascades with its attachment. |
| `calendar_sweep`          | name, cursor_at, cursor_id                                                                                                                                                                                                                                                 | The sweep's place.                                                                        |
| `calendar_member_prefs`   | member_id, calendar_id, color, hidden                                                                                                                                                                                                                                      | Per person.                                                                               |
| `calendar_availability`   | id, org_id, member_id, token_hash, calendar_ids, time_zone, hours, days, enabled                                                                                                                                                                                           | One per member and workspace. The token is stored hashed.                                 |
| `calendar_notes`          | org_id, uid, recurrence_id, node_id, created_by_member_id                                                                                                                                                                                                                  | Unique on (org_id, uid, recurrence_id). `node_id` cascades with the doc.                  |

- `message_id` is the message that last set the event, `on delete set null`: a pruned message
  leaves the event, and a re-sync sets it again.
- Mail gains one partial index, on `attachments (created_at, id)` for calendar types, so the sweep
  never scans attachments.
- Descriptions are capped at 20,000 characters and attendees at 200 per event; both are cut, never
  refused.

## API

All under `/api/calendar` on the Worker, for the active workspace. Shapes live in
`@omni/contracts/calendar.ts`, with the platform's conventions: ISO 8601 instants, `YYYY-MM-DD`
days, errors as `{ error, code }`.

| Route                                               | Does                                                                                                 |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /calendars` · `PATCH /calendars/:id`           | The calendars the member can see, with their inbox, color and whether shown. Set color, hidden.     |
| `GET /events?from=&to=&calendar=`                   | Events and expanded instances overlapping the window (at most 62 days), across shown calendars.     |
| `GET /events/:id`                                   | One event with its attendees, its thread when the member can open it, and its notes doc id.          |
| `POST /events` · `PATCH /events/:id` · `DELETE`     | Make, change, delete an event made in Omni on a calendar of an inbox the member may send from. Sends invitations, updates and cancellations. |
| `POST /events/:id/answer`                           | `{ response: accepted \| declined \| tentative }`. Sends the reply.                                  |
| `GET /invites?thread=`                              | The invitations in a thread the member can open, with their event and the member's answer.            |
| `GET /free-busy?from=&to=&addresses=`               | Busy blocks for the member's own calendars and for teammates' inboxes the member can see.            |
| `POST /events/:id/notes`                            | `{ teamspaceId? }`. Finds or makes the meeting's notes doc and returns its node id.                  |
| `GET /availability` · `PUT /availability` · `POST /availability/reset` | The member's availability link, its settings, and a new token.                      |
| `GET /api/availability/:token`                      | Public. Free and busy for the next 14 days, no titles. 404 when off or reset.                        |

- Writes publish `{ type: "calendar.changed", calendarIds }` to the sockets of each calendar's
  inbox members.
- Error codes: `NOT_FOUND`, `NOT_ORGANIZER` (an invitation's details are its organizer's), `NOT_INVITED`
  (no attendee line for the inbox to answer), `WINDOW_TOO_LARGE`, and the platform's
  `BILLING_INACTIVE` for writes on a read-only workspace.
- A Personal space has a calendar too: its inboxes are in it.

## Agents

Two read tools on the MCP server, scope `calendar:read`, through the same door:

| Tool                  | Does                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `calendar_events`     | Events in a window (default the next 7 days, at most 62), optionally by words in the title or an attendee. Each with its people, answer, video link, thread id for `fetch`, and `url`. |
| `calendar_find_times` | Free slots of a given length in a window for the person and any teammates whose inboxes they can see, inside working hours in a time zone it is given (Omni keeps none per person). Returns up to 10, soonest first, as text ready to paste. |

Agents never send: making events, answering and cancelling reach people outside Omni, so they stay
with a person in the app, as sending does for mail. Event titles and descriptions come from
other people's invitations; the server's instructions keep telling agents to treat them as data.

## Recording, later

Not built in this stack. The goal: good, cheap transcripts of a meeting, saved as the meeting's
notes doc, searchable by agents, with the people in it knowing.

**Where the audio is captured**

| Option                                        | How                                                                                                 | For                                          | Against                                                                 |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------- |
| **Desktop app, no bot** (Granola, Amie)       | The Tauri shell records the microphone and the system's output (ScreenCaptureKit on macOS, WASAPI loopback on Windows) | Any meeting app, in person too; nobody joins the call | Only the person's own computer; speakers are "me" and "them" without diarization |
| Browser tab                                   | `getDisplayMedia` with tab audio in the web app, plus the microphone                                 | No install                                   | Chrome only for tab audio, and the person must keep the tab shared      |
| A bot joins the call (Recall.ai and others)   | A third party joins Zoom, Meet or Teams as a participant                                            | Per-speaker audio, works with no app open     | About $0.50 to $1 an hour on top (estimate; check), a vendor holding the audio, and a stranger in every call |
| iPhone                                        | The app records the room                                                                           | In-person meetings                           | Waits for the iOS calendar                                               |

The recommendation is the desktop app, with the browser tab as the fallback: no bot in anyone's
call, no vendor holding audio, and it works for every meeting app.

**Transcription** (list prices in November 2026, batch, per hour of audio)

| Provider                                       | Per hour   | Speakers                     | Notes                                                                                   |
| ---------------------------------------------- | ---------- | ---------------------------- | --------------------------------------------------------------------------------------- |
| Cloudflare Workers AI, `whisper-large-v3-turbo` | ≈ $0.03    | No                           | Runs beside the Worker as a binding: no new vendor, no key. 99 languages.               |
| Groq, `whisper-large-v3-turbo`                 | $0.04      | No                           | OpenAI-compatible API.                                                                  |
| AssemblyAI Universal-2                         | $0.15      | +$0.02                       | Good diarization and Spanish.                                                           |
| Deepgram Nova-3 (multilingual)                 | $0.26 to $0.31 | Included                  | The best-known for meetings; code-switching between English and Spanish.                |
| OpenAI `gpt-transcribe`                        | $0.27      | No                           | `gpt-4o-transcribe-diarize` retires in Feb 2027.                                         |
| Self-hosted Whisper (`faster-whisper`, WhisperX) | the machine | WhisperX, with pyannote    | Any OpenAI-compatible server (`speaches`); a CPU machine takes about real time.        |

A team of ten with ten hours of meetings each a week records about 430 hours a month: about $13 on
Workers AI, $73 on AssemblyAI with speakers, $130 on Deepgram. The desktop capture records the
microphone and the call as two channels, so "me" and "them" come free; full diarization is only
needed for in-person meetings.

The recommendation: Workers AI Whisper by default (it fits `v1.md`'s budget and needs no
configuration on Cloudflare), and any OpenAI-compatible transcription endpoint for self-hosters
and for a better model (`TRANSCRIBE_URL`, `TRANSCRIBE_MODEL`, and the key as a secret), chosen
by environment variable. A summary at the top of the notes doc comes from Claude Haiku through
`@omni/ai`, under the daily AI cap (an hour's transcript is about 15k tokens in).

**Storage.** The recording is a Drive file beside the notes doc: Opus at 24 kbit/s is about 11 MB
an hour. The transcript goes into the doc, with times and speakers, and Drive's indexer makes it
searchable. By default the audio is deleted once the transcript is saved; a workspace can keep it.
It counts against the workspace's Drive quota like any file.

**Consent.** Recording law differs by place: in several US states (California among them) everyone in
the call must agree to being recorded, and in the EU the GDPR asks for notice and a lawful basis.
Omni treats every meeting as the strictest case. So:

- Recording starts only by a person's action, never on its own, and the app shows it while it runs.
- Starting asks the person to confirm everyone was told; Omni keeps who started it and when.
- An event made in Omni can say in its invitation that the meeting will be transcribed.
- The notes doc says at its top that it holds a transcript, of which meeting, recorded by whom.
- A workspace setting turns recording off for everyone.

**Plan when it comes:** capture in the desktop shell; an upload into Drive through the existing
multipart path; a queue job that transcribes and writes the doc; then speakers.

## Plan

Each line is one PR. The spec goes on `main` alone. The build is one `gh stack`, smallest useful
first; its migration sits on top of the teamspaces stack (`#704` to `#754`, migrations 0067 to
0069), per AGENTS.md "Migrations number in stack order", so the first layer of this stack is a
layer on that one.

| #   | Layer                                                                                                        | Depends on     |
| --- | ------------------------------------------------------------------------------------------------------------ | -------------- |
| K0  | This document                                                                                                | main           |
| K1  | Parsing and expansion in `@omni/mail-core`; the schema; the door; the sweep that reads invitations from mail | `#754`         |
| K2  | The Worker API and agents: events, answering and sending through the outbox, free/busy, availability, MCP    | K1             |
| K3  | The web views: week and day, keys, calendars, the event panel, the invitation card in threads               | K2             |
| K4  | Twined: `meetingsWith`, meetings on CRM records and deals, notes docs in Drive                              | K3             |

Each layer is done when its e2e tests pass against the local stack and it has been run by hand.
Each test is named for the bug it catches.

**K1. Invitations in, through the door**

- `@omni/mail-core` (unit, fixtures in `fixtures/ics/`): Google, Outlook and Apple invitations
  parse to the same event shape; Outlook's Windows zone without a `VTIMEZONE` lands at the right
  instant; a weekly series keeps its local hour across the change to winter time; an `EXDATE`
  removes its instance and a changed instance replaces its own; an all-day event is days, not
  midnights in UTC; an endless series stops at the window.
- `apps/mail` (GreenMail): an invitation delivered over SMTP is stored with its `text/calendar`
  attachment, bytes and all.
- `@omni/db`: a member on the inbox sees the event and one who is not does not, admins included; a
  member of another workspace sees nothing; an update with a lower sequence changes nothing; a
  cancellation from someone other than the organizer changes nothing; a reply changes only its
  sender's answer; applying the same parts in reverse order ends in the same state; deleting the
  calendar tables and sweeping again gives the same events.
- Worker: an attachment that arrives is on the calendar within seconds of the arrival event, and
  the minute sweep picks it up when the event never came; Junk is skipped.

**K2. API and agents**

- Answering Yes queues one send with a `REPLY` from the invited inbox to the organizer, and a
  retried request queues no second one; the mail service sends it with a `text/calendar` part.
- Changing an event's time sends one update with a higher sequence to each guest; removing a guest
  sends them a cancellation.
- A member without access to a shared inbox gets `404` for its events, invites and free/busy.
- The public availability page shows busy blocks and no title, person or place; a reset link
  answers `404`.
- A read-only workspace reads every route and gets `402` on every write.
- `calendar_events` with a token granted one workspace sees none of another's.

**K3. Web**

- Run against the local stack with `pnpm stack:serve`: create, move, resize, delete and answer by
  keys and by mouse; an invitation card in a thread; calendars toggled.

**K4. Twined**

- A deal's meetings are the ones on calendars the viewer can see, and a teammate who cannot open
  the inbox sees none of them.
- Two members open Notes on the same meeting at the same moment and get one doc.

## Changes to other specs

- `modules.md`: Calendar is "Specified: `docs/spec/calendar.md`", its first source is mail
  rather than CalDAV, and the Calendar → CRM link reads `meetingsWith`.
- `v1.md`: Calendar leaves its non-goals.
- `mcp.md`: the `calendar:read` scope and the two tools, with K2.

## Open questions

- [ ] Month view: left out of v1. Add it when someone asks twice.
- [ ] Does a shared inbox's calendar answer invitations as the inbox (anyone on it can), or only
      its assignee? v1: anyone on it, as anyone can reply.
- [ ] Working hours: per availability link in v1. A workspace default later?
- [ ] CalDAV spike against Purelymail: which of `sync-collection`, `ctag` and `ETag` it supports.
- [ ] Recording: Workers AI Whisper as the default, or AssemblyAI for speakers from the start.
