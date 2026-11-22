# Meetings: record a call, get a transcript with names, and notes that remember

Nov 22, 2026 · Draft for review · Extends `docs/spec/modules.md`, `docs/spec/calendar.md`
("Recording, later", now this document) and `docs/spec/crm.md`

## Summary

A person records a meeting from Omni: a client call on Zoom, a team kickoff on Meet, a
conversation in a room. Nobody joins the call. When it ends, Omni has a transcript that says who
said what, by name, and notes written from it: a summary, the decisions, the things to do and a
follow-up email ready to send. Meetings that belong together (every week's kickoff, every call
with one client) read as one page with a running summary and a timeline of what was decided, like
the reference screenshot from Amie.

It is a new module, **Meetings**, next to Calendar and the CRM:

- **It works with the calendar.** Recording an event uses the event's title, time and attendees,
  and its notes are the event's notes doc. A recording with no event works too.
- **It works with the CRM.** A deal (a project) has a Meetings tab: every recorded call on it,
  newest first, with its summary and its open actions. People and companies show their meetings
  in their timelines.
- **It is good where it matters.** Words right in English and Spanish, mixed in one call, and
  the right name on every line.

The engine choice is AssemblyAI Universal-3.5 Pro with speaker labels and speaker
identification, about **$0.25 an hour of audio**; why below. The engine sits behind one
interface, so a self-hoster can point it at any OpenAI-compatible server or Workers AI.

## Goals and non-goals

**Goals**

- One action records any meeting, on any meeting app or in a room, with no bot in the call.
- Transcripts good enough to quote: a word error rate a reader does not notice, in English,
  Spanish and both at once.
- Every line has a speaker, and the speaker has a name: the recorder always, the other people
  most of the time, and one click fixes the rest for the whole meeting.
- Notes in under two minutes after a one-hour meeting ends.
- A deal's meetings on the deal; a series' meetings as one page.
- Agents can search and read meetings like mail and files.
- Self-hostable with no required new service: without a transcription engine configured, the
  module is off.

**Non-goals for this version**

- A bot that joins Zoom, Meet or Teams. Deferred, see "Capture".
- A live transcript during the meeting. The batch transcript after is cheaper and better (see
  "Transcription"); live comes later on the same interface.
- Recording on the iPhone. The phone is Rodrigo's and waits for the iOS calendar.
- Recognizing a voice across meetings (voiceprints). It is biometric data; see "Speakers".
- Video. Audio only.

## What we take from Circleback, Granola and Amie

| Idea                                  | Omni v1                                                        | Later                                |
| ------------------------------------- | -------------------------------------------------------------- | ------------------------------------ |
| Botless capture (Granola, Amie)       | The desktop app records the mic and the computer's sound       | The iPhone records the room          |
| Notes you type, made better (Granola) | You type in the meeting's notes doc; the AI writes around them | Templates per kind of meeting        |
| Names on the transcript (Circleback)  | The recorder by their microphone, others by the invite and AI  | Voices remembered, with consent      |
| Actions (Circleback, Amie)            | Tasks and a follow-up email draft, accepted with one click     | Actions that update CRM fields       |
| Memory across meetings (Amie)         | A series or a client is one page: summary, timeline, actions   | Ask across every meeting             |
| Ask about a meeting (Amie)            | Ask one meeting or one group, answers cite the moment          | Ask across all of them               |
| A bot in the call (Circleback)        | No                                                             | An optional bot, if people ask twice |

## How people use it

**Record.** Four ways in, one recording:

- The event panel in the calendar has **Record** while the event is on, and from five minutes
  before it.
- When an event with a video link starts and the desktop app is open, it shows a notification:
  "Record Week Kickoff?". It never starts by itself.
- The desktop app's menu bar (tray) has **Record now** for a meeting with no event.
- In a browser with no desktop app, **Record** shares a tab's sound and the microphone (Chrome and
  Edge; see "Capture").

**One recording per meeting.** A meeting on the calendar is recorded once per workspace, however
many teammates are in it: one computer's sound already carries everyone on the call. When
someone else in the workspace is already recording the event, Record reads "Ana is recording"
and opening it shows the meeting as it fills; the attendee grant gives everyone in it the result.
If that recording stops while the event is still on (Ana left, her app quit), the others are
offered Record again, and the new recording is the same meeting's second part, transcribed
after the first and joined to it. Two people in one room each pressing Record at once get one
recording: the server keeps the first and tells the second. A recording with no event has
nothing to match on and is never merged.

Starting asks once per recording: "Everyone in this meeting knows it is being recorded." The
person confirms; Omni keeps who and when. Then a small floating pill stays on top of every window:
a red dot, the time, the microphone level, pause and stop. Stopping is instant: the audio is
already mostly uploaded.

**Take notes while it records.** The meeting's notes doc (the calendar's, one per meeting per
workspace) opens beside the pill. What the person types is theirs: the AI writes around it, never
over it.

**Read.** About a minute after it ends, the meeting page is ready:

- The title, the group it belongs to (a dropdown switches between its meetings), when, who
  (faces), and Share.
- **Summary**: two or three sentences.
- **Highlights**: the moments that matter (decisions, numbers, commitments), each with its time;
  pressing one plays the audio from there while the audio is kept.
- **Actions**: cards the person accepts or dismisses. A **task** goes to the calendar's tasks
  (private, or on the deal when the meeting is on one). An **email** is a draft follow-up to the
  attendees; **Send email** opens it in Omni's composer, from the person's inbox, to send or
  change. Nothing is sent by the AI.
- **Notes**: the doc, with what the person typed and the AI's notes above it.
- **Transcript**: turns with a face, a name and a time. Pressing a name renames that speaker in
  the whole meeting: pick an attendee, a teammate, a CRM person, or type a name.
- **Ask** at the foot: a question about this meeting (or this group), answered from the
  transcript, with the times it comes from.

**Groups.** The Meetings sidebar lists groups, newest first, under Yesterday, Last week,
Previous 30 days and Past, like the reference:

- A **series**: the meetings of one recurring event (`UID`), with its count ("Week Kickoff 34").
- A **client**: meetings with one outside company, named by its domain or CRM company, with its
  logo ("amie.so 41").
- A **meeting** on its own, with a doc glyph, when it is neither.

A group's page is the reference screenshot: a summary of where things stand across its meetings,
a **Timeline** of highlights from every meeting with their dates, newest first, and its open
**Actions**. Its dropdown opens one meeting.

**On a project.** A deal's page gains a **Meetings** tab: its recorded meetings, newest first,
each with its summary, a count of open actions and a link to the meeting; above them, the deal's
next meetings from the calendar. A meeting lands on a deal by itself when its attendees are the
deal's people (`meetingsWith`, the calendar's rule), and anyone who can open the meeting can move
it to another deal or take it off. A company's and a person's timeline shows a recorded meeting
with its summary.

## Capture

Where the audio comes from decides most of the quality, so it is the first thing to get right.

| Option                           | How                                                                       | Verdict                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Desktop app, no bot**          | The Tauri shell records the mic and the computer's output on two channels | **v1.** Any meeting app or a room; nobody joins; we hold the audio                                      |
| Browser tab                      | `getDisplayMedia` with tab audio, plus `getUserMedia`, in the web app     | **v1 fallback.** Chrome and Edge only; the tab must stay shared                                         |
| A bot joins the call (Recall.ai) | A participant records per-speaker audio                                   | **Later, optional.** About $0.50 to $1 an hour more, a vendor holds the audio, a stranger in every call |
| iPhone                           | The app records the room                                                  | **Later**, with the iOS calendar                                                                        |

**The desktop recorder** (Rust, in `apps/desktop/src-tauri/src/recording/`):

- **The computer's sound.** macOS 14.4 and later: a Core Audio process tap on the system output,
  which asks only for audio-capture permission. macOS 13 to 14.3: ScreenCaptureKit with audio
  only, which asks for screen recording. Windows: WASAPI loopback on the default output.
- **The microphone** with the system's voice processing on (echo cancellation), so the call's
  sound coming out of speakers does not land on the mic channel.
- **Two channels, one file.** Left is the mic, right is the computer's sound, encoded as Opus in
  Ogg at 32 kbit/s, about 14 MB an hour.
- **Who is speaking on this computer.** The recorder notes when the mic carries speech and the
  output does not (a simple energy detector on both channels), and sends those intervals with the
  audio. That is how the recorder is named for certain (see "Speakers"), and it costs nothing.
- **Nothing is lost.** Audio is written to a spool on disk as it is encoded. Parts go up to
  Drive's multipart upload every 5 MiB (about 20 minutes, the store's smallest part); the last
  part goes up on stop. A crash, a sleep or a quit leaves the spool, and the app finishes the
  upload when it opens again. The spool is deleted once the upload completes.
- **In a room**, with no call, the right channel is silent: the transcript relies on the engine's
  speaker labels and the names step alone.

**The browser recorder** mixes nothing: it records the tab's sound and the mic as two channels
with `MediaRecorder` (Opus in WebM), computes the same mic intervals with an `AnalyserNode`, and
uploads parts the same way. It is the fallback, so it keeps no spool: closing the tab ends the
recording where it was.

## Transcription

**The choice: AssemblyAI Universal-3.5 Pro**, batch, with `speaker_labels` and speaker
identification by name. List prices in November 2026, per hour of audio:

| Engine                              | Per hour, with speakers                   | Meetings diarization (AMI, cpWER, lower is better) | Spanish WER | Notes                                                                                  |
| ----------------------------------- | ----------------------------------------- | -------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------- |
| **AssemblyAI Universal-3.5 Pro**    | **$0.21 + $0.02 speakers + $0.02 names**  | **27.4**                                           | **9.4**     | Native English–Spanish code switching; names speakers from a list we give; EU endpoint |
| ElevenLabs Scribe v2                | $0.22, speakers included; keyterms +$0.05 | 36.1                                               | 11.8        | Very accurate words; diarization weaker on meetings; multichannel only to one hour     |
| Soniox (async)                      | about $0.10, everything included          | 58.9                                               | n/a         | Cheapest, good words; speakers fall apart on meetings                                  |
| Deepgram Nova-3                     | $0.26, speakers included in batch         | 29.3 (English model)                               | n/a         | Strong in English; multilingual model costs more                                       |
| Speechmatics                        | $0.24                                     | n/a                                                | n/a         | Good multilingual; enterprise-shaped                                                   |
| OpenAI `gpt-transcribe`             | $0.27, no speakers                        | n/a                                                | n/a         | `gpt-4o-transcribe-diarize` retires Feb 2027                                           |
| Workers AI `whisper-large-v3-turbo` | about $0.03, no speakers                  | n/a                                                | n/a         | No key on Cloudflare; the floor, not the default                                       |

The diarization and Spanish columns are from AssemblyAI's own Universal-3.5 Pro benchmark, so we
treat them as a claim to check, not a fact: layer M1 runs our own comparison (see "Plan") and the
choice holds only if it wins there too.

Why AssemblyAI, in order of what the person notices:

1. **Speakers are the product.** A transcript with the wrong person on a line is worse than a few
   wrong words: it puts a commitment in someone else's mouth. Universal-3.5 Pro has the best
   meetings diarization of the ones measured, and it is the one engine that also **names**
   speakers from a list we give it (the event's attendees), for two cents an hour.
2. **Spanish and English in one call.** Its code switching is native, and its Spanish error rate
   is the lowest listed.
3. **Cost is not the constraint.** A team of ten with ten hours of meetings each a week records
   about 430 hours a month: about $110 with AssemblyAI against $43 with Soniox. The $65 buys the
   speaker quality; the summary step costs about the same either way.
4. **It fits the Worker.** It takes a streamed upload (no public URL to the audio), and its jobs
   are polled or call back, so no Worker waits on an hour of audio.

**Batch, not live.** A live transcript costs more ($0.30 an hour streaming against $0.25) and is
worse: live diarization sees only the past. Batch on the whole file finishes in well under a
minute for an hour. A live view can come later on the streaming endpoint without changing the
model.

**What we send.** The audio (both channels; the engine mixes them), the language left to
detection, `speakers_expected` between 2 and the attendee count plus one, the attendees' names as
the known speakers, and as key terms: the attendees' names, the companies and the deal's name. We
ask for words with times, speakers and confidence.

**Behind one interface.** `TRANSCRIBE_PROVIDER` picks the engine:

| Provider     | What it needs                                          | Speakers                                      |
| ------------ | ------------------------------------------------------ | --------------------------------------------- |
| `assemblyai` | `TRANSCRIBE_API_KEY`; `TRANSCRIBE_URL` for the EU host | Labels and names                              |
| `openai`     | `TRANSCRIBE_URL`, `TRANSCRIBE_MODEL`, maybe a key      | When the server returns them (WhisperX does)  |
| `workers-ai` | The `AI` binding                                       | Only "me" and "them", from the two channels   |
| `none`       | Nothing (the default)                                  | The module is off and its routes answer `404` |

Each provider is an adapter in the Worker that submits, polls and returns the provider's JSON.
Turning that JSON into Omni's transcript is pure code in `@omni/ai`, tested on recorded
responses, so changing engines changes one adapter and one normalizer.

## Speakers

Who said what is worked out in four steps. Each step only fills what the one before left open,
and a person's correction always wins.

1. **The recorder, from their microphone.** The engine's speaker whose speech falls most inside
   the mic intervals (at least 60% of their speaking time, and the most of anyone) is the person
   who recorded. Certain, and free. When a second speaker is also mostly on the mic (30% or more),
   everyone is on it, as in a room with one computer, and the mic names nobody: steps 2 to 4 do. In a call between two people, the other speaker is then the
   one other attendee: a two-person call is fully named without any AI.
2. **The engine's names.** AssemblyAI's speaker identification maps the remaining speakers to the
   attendee names we gave it, when the audio supports it ("Thanks, Ana").
3. **Our names pass.** What is still unnamed goes to Claude Haiku with the transcript's first
   minutes and the attendee list, through `@omni/ai`'s structured call: a name only with a
   reason quoted from the transcript, otherwise none. This also catches people who joined
   without an invitation.
4. **The person.** Renaming a speaker sets it for every line of that meeting and is remembered
   on the meeting.

A name joins a person by address when it can: an attendee's address makes a speaker a teammate
(their face) or a CRM person (their record), at read time. A speaker no step could name reads
"Speaker 2".

**Voiceprints are deferred on purpose.** Remembering voices would name people in a room meeting
without an invitation, but a voiceprint is biometric data: explicit consent under the GDPR
(article 9) and written consent under Illinois' BIPA, per person recorded. Not in v1.

## The notes

After the transcript and the speakers are saved, one structured call to Claude Haiku (the
`AI_MODEL` the rest of Omni uses) writes the notes from the transcript, the attendees, the
event's description and what the person typed during the meeting. An hour's transcript is about
15k tokens in and 2k out; meetings over three hours are summarized in parts, then together. It
runs under the workspace's daily AI cap like every other AI job, and in the meeting's language.

It returns, against a schema:

- `title` when the meeting had none, `summary` (at most three sentences);
- `highlights`: up to 8, each `{ text, atMs }`, decisions and figures first;
- `actions`: up to 10, each a task `{ title, ownerSpeaker?, due? }` or an email
  `{ to: addresses from the attendees, subject, body }`;
- `topics`: up to 5 short tags.

The notes go into the meeting's doc once, above what the person typed, under a line saying it was
written from the recording; after that the doc is the people's and is never rewritten. They go in
only when nobody can open the doc who cannot open the meeting (Storage's door says who reaches
the doc, a teamspace's members included); otherwise the doc gets a link to the meeting instead,
so the doc never shows a summary to someone the meeting's sharing leaves out. The
structured parts are also kept on the meeting for its page, its group and the CRM.

**Groups** keep summaries of their own, one per set of meetings a reader can open: a summary is
made only from the meetings its reader can open, and kept under the group and the ids of those
meetings, so readers who see the same meetings share it and nobody gets one built from a meeting
they cannot open. A summary is made from the last 12 such meetings' summaries and highlights
(not their transcripts, so it stays small), on the first read after a meeting in it is ready. The timeline is the highlights themselves, read at once, newest first.

**Ask** answers one question about one meeting or one group: the meeting's transcript, or, for
a group, only the meetings the asker can open: their summaries and highlights plus the transcripts of the meetings that match the question
best. Answers cite `[mm:ss]` moments, which the page links to the transcript. It is a turn, not a
chat history, and it counts toward the AI cap.

## Sharing

A meeting is shared the way a Drive file is, made lighter: people, by address, and a link. The
access covers the meeting page, its transcript, its notes, its actions, and its audio.

- **Attendees get access by themselves.** When the recording starts, every attendee address on
  the event gets a `viewer` grant: teammates, freelancers and people outside the workspace alike.
  They were in the meeting, so they can read it. The recorder is its `owner`.
- **Anyone can be invited.** Share takes addresses, like Drive: `viewer` reads, `editor` also
  renames speakers, edits the title, moves it to a deal, accepts actions and shares it on. An
  address outside the workspace opens it by signing in with that address (`forUser`), as with a
  file shared with them; they get an email with the link, from the person sharing it.
- **The workspace.** General access is `restricted` (only grants) by default, or `workspace`
  (every teammate can view). Freelancers never get a meeting through `workspace`, only through a
  grant, as in Drive.
- **A link.** Off by default; when on, anyone with it views the meeting after signing in, or with
  no sign-in when the workspace's Drive settings allow public links (`public_links`). The same
  workspace settings that close Drive's public links and outside sharing close these.
- **Removing a grant**, an attendee's included, takes the access away. Owners and editors can.
- **Groups** show only the meetings the viewer can open; a group's summary and timeline are made
  from those meetings only, per viewer: a group page with a meeting you cannot open shows its
  date and title at most.
- **The notes doc is Drive's**, as the calendar specifies. Sharing a meeting adds the same people
  to its notes doc with the same role, through Storage's door, so the two do not drift on the
  day it is shared; after that each is managed where it lives.
- **On a deal**, the meeting shows on the deal's Meetings tab only to those who can open both
  the deal and the meeting. Putting it on a deal grants nobody anything.
- A workspace setting turns recording off for everyone. Owners and admins see that a meeting was
  recorded and by whom, never its content, unless it was shared with them.

Why not make the meeting a Drive node and reuse Storage's grants: a meeting has a transcript,
speakers, actions and a group, which a file does not, and the CRM and the calendar would have to
reach a meeting through Storage. The grant rows are small and copy Drive's shape (address, role,
who granted, when) so the sharing panel can be the same component.

## Consent

Recording law differs by place: in several US states (California among them) everyone in a call
must agree to being recorded, and in the EU the GDPR asks for notice and a lawful basis. Omni
treats every meeting as the strictest case:

- Recording starts only by a person's action, and the pill shows it while it runs.
- Starting asks the person to confirm everyone was told; Omni keeps who and when on the meeting.
- An event made in Omni can say in its invitation that the meeting will be transcribed.
- The notes say at their top that they were written from a recording, of which meeting, by whom.
- The follow-up email draft says the meeting was recorded, so the people in it hear it again.

## Audio

The recording is a Drive file in the recorder's My files, in a `Recordings` folder, counted
against the workspace's quota, and never in a teamspace, whose members and admins Drive lets in
by itself. It is shared with nobody in Drive: everyone else plays it through
`GET /api/meetings/:id/audio`, which checks the meeting's grants and then reads the file by its
node id through Storage's surface for the workspace, as Talk reads a sent file's metadata, never
acting as a member. When the recorder leaves the
workspace, the files go with the rest of their My files to whoever receives them
(`handOverMemberStorage`); the meeting keeps the same node ids, so playback and the retention
sweep work as before. It plays on the
meeting page and is kept as long as the meeting is, so a quote can always be heard again; a
workspace can choose to delete recordings after a number of days instead, or as soon as the
transcript is saved, and the sweep does it. The engine's raw response is kept in R2 under
`meetings/<org>/<meeting>/engine.json`, not in Drive (nobody opens it), so speakers can be worked
out again without paying twice. Deleting the meeting deletes it and moves the recording to the
recorder's Drive Trash.

AssemblyAI deletes the audio it was sent once the transcript is fetched: the adapter calls its
delete endpoint after saving.

## Model

All tables carry `org_id`, cascade with the workspace, and are named `meetings_*`.

| Table                | Key fields                                                                                                                                                                                                                                                                                                                                       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meetings_meetings`  | id, org_id, title, started_at, ended_at, duration_ms, event_uid, event_recurrence_id, group_key, record_kind, record_id, access (`restricted` · `workspace`), link_access (`off` · `signed_in` · `anyone`), link_token, recorded_by_member_id, part, consent_at, status, language, audio_node_id, notes_node_id, failure, created_at, updated_at | Unique on (org_id, event_uid, event_recurrence_id, part) where the event is set, with `part` counting from 1; `event_recurrence_id` is `''` for an event that does not repeat, never null, so the key holds for it. `status`: `recording` · `uploaded` · `transcribing` · `naming` · `writing` · `ready` · `failed`. The event is referenced by its iCalendar identity, the CRM record by kind and id, with no foreign key into either module. |
| `meetings_attendees` | meeting_id, org_id, address, name                                                                                                                                                                                                                                                                                                                | Copied from the event at start, or added on the page; each gets a `viewer` grant.                                                                                                                                                                                                                                                                                                                                                              |
| `meetings_grants`    | meeting_id, org_id, address, role (`owner` · `editor` · `viewer`), granted_by_member_id, created_at                                                                                                                                                                                                                                              | Key (meeting_id, address). Drive's grant shape, by address.                                                                                                                                                                                                                                                                                                                                                                                    |
| `meetings_speakers`  | meeting_id, label, org_id, name, address, source (`mic` · `engine` · `ai` · `person`), confidence                                                                                                                                                                                                                                                | Key (meeting_id, label). The label is the engine's.                                                                                                                                                                                                                                                                                                                                                                                            |
| `meetings_segments`  | meeting_id, seq, org_id, speaker_label, start_ms, end_ms, text, search (tsvector, `simple`)                                                                                                                                                                                                                                                      | Key (meeting_id, seq). One per turn; words and their times stay in the raw file.                                                                                                                                                                                                                                                                                                                                                               |
| `meetings_notes`     | meeting_id, org_id, summary, highlights, actions, topics, model, prompt_version, written_to_doc_at                                                                                                                                                                                                                                               | `jsonb` parts, written in one go.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `meetings_actions`   | id, meeting_id, org_id, kind (`task` · `email`), payload, state (`open` · `done` · `dismissed`), task_id, decided_by_member_id                                                                                                                                                                                                                   | An accepted task keeps the calendar task's id.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `meetings_groups`    | org_id, group_key, meetings_hash, title, summary, summarized_through, updated_at                                                                                                                                                                                                                                                                 | Key (org_id, group_key, meetings_hash): one per set of meetings read.                                                                                                                                                                                                                                                                                                                                                                          |
| `meetings_jobs`      | meeting_id, org_id, provider, provider_job_id, mic_intervals, submitted_at, polls                                                                                                                                                                                                                                                                | One per meeting; what makes each job safe to run twice.                                                                                                                                                                                                                                                                                                                                                                                        |

`group_key` is `series:<UID>` for a recurring event, `domain:<domain>` for meetings with one
outside company (the most common outside domain among the attendees, skipping webmail), else
`meeting:<id>`.

Reads and writes go through `forMember(db, memberId).meetings` and, for people outside the
workspace, `forUser(db, userId).meetings`; both apply "Sharing" by the user's verified
addresses. The surface offers the CRM `meetingsOn(record)` and `setRecord`, and offers search to
the Worker's merged search.

## Pipeline

Every step is a queue job keyed by the meeting, idempotent, and moves `status` forward only from
the status before it.

1. **Start.** `POST /api/meetings` makes the meeting in `recording`, copies the event's attendees
   and answers with the recorder's private `Recordings` folder, made on first use. The app
   uploads the audio there through Drive's own resumable upload (`/api/storage/uploads`), part
   by part as it records, so the upload, its limits and its checks are Drive's.
2. **Stop.** `POST /api/meetings/:id/stop` names the uploaded file (it must be the recorder's own,
   in their My files), the mic intervals and the dropped silences, sets `uploaded` and enqueues
   `transcribe`.
3. **Transcribe.** Streams the audio from R2 to the engine's upload (no buffering, no public
   URL), submits the job and stores its id; a retry that finds the id skips to polling. Then
   `poll` every 20 seconds, up to an hour, with the engine's callback as a shortcut when the
   Worker's URL is reachable.
4. **Save.** Fetches the result, keeps the raw file, normalizes it, works out the speakers (steps
   1 and 2), and replaces the meeting's segments and speakers in one transaction. `naming`.
5. **Name.** The names pass (step 3) when a speaker is still unnamed. `writing`.
6. **Write.** The notes call; writes `meetings_notes`, the actions, and the doc once. `ready`,
   and a push to the recorder. The group's summaries are made again on their next read.

A step that fails three times sets `failed` with what failed; the page offers **Try again**,
which starts from that step. Any failure in transcription leaves the audio, so nothing said is
lost.

## API

Under `/api/meetings`. Recording needs a paid plan with minutes left this month (`hasAllowance`,
then `gateMeter` with `meetingMinutes` and `always` for the recording's minutes when it ends;
`docs/spec/billing.md`). Member sessions reach everything below;
a signed-in user outside the workspace reaches `GET /:id`, its transcript, audio and Ask on
meetings shared with them. A meeting the caller cannot see answers `404`.

| Route                                                                | What                                                                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `GET /groups?before=`                                                | The sidebar: groups, newest first, with count and last meeting            |
| `GET /groups/:key`                                                   | A group's summary, timeline, open actions and meetings                    |
| `GET /?event=<uid>&recurrence=`                                      | The meeting for an event, so the calendar panel shows it                  |
| `POST /` `{ event?, title?, consent: true }`                         | Starts one; returns its id and the upload                                 |
| `POST /:id/stop` `{ audioNodeId, durationMs, micSpans, cuts }`       | Stops and starts the pipeline                                             |
| `GET /:id`                                                           | The meeting: status, attendees, notes, actions, speakers                  |
| `GET /:id/transcript`                                                | Segments with speakers                                                    |
| `GET /:id/audio`                                                     | The audio, through Storage's door                                         |
| `PATCH /:id` `{ title?, access?, link?, record? }`                   | Change, general access and the link, or move to a deal                    |
| `GET /:id/grants` · `PUT /:id/grants/:address` `{ role }` · `DELETE` | Who it is shared with; invite, change, remove                             |
| `PUT /:id/speakers/:label` `{ name, address? }`                      | Rename a speaker                                                          |
| `POST /actions/:id/accept` · `/dismiss`                              | A task is made through the calendar's surface; an email returns its draft |
| `POST /ask` `{ meetingId \| groupKey, question }`                    | One answer, streamed, with cited moments                                  |
| `POST /:id/retry`                                                    | Runs the failed step again                                                |
| `DELETE /:id`                                                        | Deletes the meeting, its transcript and its audio; the notes doc stays    |

Realtime: `meetings.changed { meetingId, status }` on the workspace's socket to the members who
can see it, so the page fills in without polling.

## Twined with the other modules

`scripts/check-modules.mjs` gains `meetings: { uses: ["calendar", "storage"], prefixed: true }`,
and the CRM's `uses` gains `meetings`.

| Link                 | What a person sees                                                     | How                                                                          |
| -------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Calendar → Meetings  | Record on an event; its attendees and its notes doc                    | Meetings reads the event and the notes doc through the calendar's surface    |
| Meetings → Calendar  | An accepted task                                                       | The calendar's task surface, on the meeting's deal when it has one           |
| Meetings → Storage   | The audio, the raw file and the AI's notes in the doc                  | Storage's door, as Talk and the calendar do                                  |
| CRM → Meetings       | A deal's Meetings tab; meetings in a person's and a company's timeline | The CRM checks the record and the project, then reads `meetingsOn(record)`   |
| Meetings → Mail      | Send the follow-up                                                     | Nothing on the server: the web opens the composer with the draft             |
| The calendar's panel | "Recorded" and a link on a past event                                  | The web asks `GET /api/meetings?event=`; the calendar does not read Meetings |

## Agents

With the `meetings:read` scope:

| Tool              | What                                                                     |
| ----------------- | ------------------------------------------------------------------------ |
| `meetings_search` | Meetings by words in their transcripts and notes, people, dates and deal |
| `meetings_fetch`  | Up to 5 meetings: notes, actions and the transcript with names and times |

Transcripts are what people said: the server's instructions tell agents to treat them as data.

## Cost

What costs money is hours of audio sent to the engine, so the module sends each hour once and
sends no silence:

- **One recording per meeting** (above): a call with four teammates in it is one hour, not four.
  For a team whose meetings are mostly internal, this is the largest saving.
- **No silence.** The desktop recorder drops the stretches where neither channel carries sound
  for more than 30 seconds (the minutes before people join, a break) and keeps a map of what it
  dropped, so times still match the meeting's clock.
- **It stops itself.** A recording of an event stops 10 minutes after the event's end once both
  channels have been silent for 2 minutes, so a forgotten pill does not bill for an evening.

For the team of ten above, 430 hours a month before these savings:

| Part                                | A month                                                |
| ----------------------------------- | ------------------------------------------------------ |
| AssemblyAI, with speakers and names | about $110                                             |
| Claude Haiku: names, notes, groups  | about 430 × 20k tokens in; small next to transcription |
| R2: 14 MB an hour, kept             | 6 GB more each month, about $0.09 more each month      |

About 25 cents an hour of meeting all in. At 3 hours of meetings a week per person, one person
is about 13 hours a month, about $3.25; a team of ten about $33 a month, less what one recording
per meeting saves on their meetings with each other. The engine is the bill; Workers AI would make it about
3 cents with only "me" and "them" as speakers.

## Self-hosting

New variables in `apps/worker/.dev.vars.example` and `docs/self-hosting.md`, none required:
`TRANSCRIBE_PROVIDER` (default `none`), `TRANSCRIBE_URL`, `TRANSCRIBE_MODEL`, and
`TRANSCRIBE_API_KEY` as a secret. With `none` the rail has no Meetings and the calendar no Record.

## Defaults chosen here

- AssemblyAI Universal-3.5 Pro, batch, with speaker labels and names.
- Attendees get `viewer` by themselves; anyone can be invited by address; no link.
- Audio kept as long as the meeting.
- The AI writes into the notes doc once, above the person's notes.
- No bot, no live transcript, no voiceprints in v1.

## Plan

One `gh stack` rooted on `main`, smallest useful first. M1 changes no module and can sit beside
the rest. The migration in M2 numbers on top of whatever is on `main` then.

| #   | Layer                                                                                                                                                                                                                                                                                        | Depends on |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| M0  | This document, and the calendar, modules and CRM specs to match                                                                                                                                                                                                                              | main       |
| M1  | `@omni/ai`: normalizers for AssemblyAI, OpenAI-compatible and Workers AI; `resolveSpeakers`; the names and notes prompts; recorded fixtures. An eval on public AMI meetings (CC BY 4.0) and two anonymized Spanish and mixed calls, comparing AssemblyAI, Scribe and Soniox on WER and cpWER | M0         |
| M2  | `@omni/db`: the schema, the migration, the member door, `meetingsOn`; leak tests; `check-modules` entry                                                                                                                                                                                      | M1         |
| M3  | Worker: `/api/meetings`, Drive upload into `Recordings`, the pipeline jobs and engines, realtime, the variables; e2e on the local stack with recorded engine and model responses                                                                                                             | M2         |
| M3b | Worker: group summaries and Ask (Claude), the notes written into the doc, routes for people outside the workspace (the user door), an accepted task made in the calendar once its tasks exist (T1)                                                                                           | M3         |
| M4  | Desktop: the recorder (Core Audio tap, ScreenCaptureKit, WASAPI), the spool and upload, the pill, the tray and the start notification                                                                                                                                                        | M3         |
| M5  | Web (Rodrigo, from Figma): the Meetings module, Record in the event panel, the browser recorder                                                                                                                                                                                              | M3         |
| M6  | CRM: the Meetings tab on a deal, meetings in timelines                                                                                                                                                                                                                                       | M5         |
| M7  | MCP: `meetings_search`, `meetings_fetch`                                                                                                                                                                                                                                                     | M3         |

What each layer must prove:

- M1: on the eval set, the chosen engine's cpWER beats the others', or this spec changes before
  M2. `resolveSpeakers` names the recorder in every two-channel recording and the other person in
  every two-person one.
- M2: nobody sees a meeting without a grant or `workspace` access, a freelancer never through
  `workspace`, and a removed grant closes it at once; a group summary or group Ask never uses a
  meeting its reader cannot open; a teamspace member reaches no recording through Drive.
- M3: a recording stopped mid-transcription and retried ends with one transcript, one set of
  actions and one block in the doc.
- M4: killing the app mid-meeting and opening it again finishes the upload with nothing missing.

**Later:** a live transcript on the streaming endpoint; the iPhone; an optional bot; Ask across
every meeting; voiceprints with per-person consent; templates per kind of meeting.

## Open questions

- [x] Who sees a meeting: shared like Drive, attendees by themselves (founder, Nov 22, 2026).
- [x] A bot in v1: no (founder, Nov 22, 2026).
- [x] A live transcript in v1: no, after the meeting (founder, Nov 22, 2026).
- [x] Audio: kept as long as the meeting (founder, Nov 22, 2026).
- [ ] Do outside attendees get their grant at once, or when the recorder first opens the notes,
      so they never get a summary nobody has read? v1: at once, as decided.
- [ ] Figma frames for the Meetings module, the pill, the sharing panel and the deal's tab.
