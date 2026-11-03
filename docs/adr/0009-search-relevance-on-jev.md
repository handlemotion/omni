# 0009: Search returns threads, recalled by full text and ordered by Jev

Date: 2026-11-03 · Status: accepted

## Context

The spec ("Search") is Postgres full-text search over subject, sender and `clean_text`, and
nothing else. The first version returned one row per matching message, newest first, and
required every word of the query. People type what they mean ("the invoice from Nightwatch last
month", "who asked about the contract"): most of those words are not in the mail, so an
all-words match finds nothing, and newest-first puts a release note above the invoice.

## Decision

`GET /api/search` returns one row per thread, best first: the best-matching message's subject,
sender and date, the thread's mailbox, its message count, and a short snippet around the match.

1. **Recall stays Postgres, bounded per granted mailbox** (`forMember().search`): every word
   (web search syntax), each word on its own (the last as a prefix while typing), and a word
   inside a sender address (the full-text index keeps `billing@nightwatch.io` as one token),
   each capped at the newest few hits. Words are weighted by how rare they were among the hits,
   with a recency boost. No per-row `ts_rank`: reading every hit's vector dominated the cost.
2. **Jev orders the best 30 candidates** (`@omni/ai` `judgeRelevance`): one request, one Noul
   per candidate ("Is `thread` the email thread the person who typed `query` is looking for?"),
   following TypeSafe's re-ranking cookbook. The state holds the query and today's date; each
   candidate's subject, sender, date with its distance from today ("3 weeks ago"), mailbox and
   an excerpt ride in its own question. Code sorts by the Noul, full-text order breaking ties.
3. **Full-text order is the fallback, never a guess**: no `TYPESAFE_API_KEY`, a failed call, a
   missing answer, or 1.5 s without an answer, and the response is the full-text order with
   `ranking: "text"`. Self-hosters without TypeSafe get working search.
4. Judgments are cached per Worker isolate for two minutes, keyed by model, query and message,
   so the popover and the results page for the same query ask once.

## Measurements

- Relevance (`pnpm --filter @omni/ai record:search`, six invented queries over ten threads): the
  wanted thread first 6/6 with Jev, 0/6 newest-first.
- Jev latency: 75 to 450 ms per request for 10 candidates (~2.8k input tokens, about $0.0001).
  On the local stack with 30 candidates the whole request took 110 to 190 ms.
- Postgres (`perf:explain`, 200k messages, 12 mailboxes): one word 10 to 40 ms, multi-word
  queries 90 to 190 ms, against 0 to 100 ms for the old all-words query.

## Consequences

- Search sends query text and short excerpts of matching mail to TypeSafe, as triage already
  sends whole messages. Same vendor, same opt-in (`TYPESAFE_API_KEY`).
- Search tokens are not written to `ai_usage`: a search costs a hundredth of a cent, and
  recording it would add a write to every keystroke-driven request. Revisit if usage grows.
- Recall caps can miss an old match of a very common word. Mail older than the per-word cap
  still comes back through the all-words match and through rare words.
