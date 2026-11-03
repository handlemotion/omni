// Search through the member API: the real Worker under workerd over a real Postgres. The mail is
// the invented threads in `fixtures/search/threads.json`, dated relative to now as they are to
// the fixture's `now`. TypeSafe is the one outside service: an HTTP server answers each
// relevance question with the Noul Jev gave live for that query and thread subject
// (`fixtures/search/recordings`), and can be switched to fail or to hang.
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
  grant,
  seedMessage,
  signIn,
  startMailServiceEndpoint,
  startWorker,
  SYSTEM_MAIL_FROM,
} from "./support.ts";

const fixtures = new URL("../../../fixtures/search/", import.meta.url);
const fixture = JSON.parse(readFileSync(new URL("threads.json", fixtures), "utf8")) as {
  now: string;
  mailbox: string;
  threads: Array<{
    id: string;
    subject: string;
    from: { name: string; address: string };
    sentAt: string;
    text: string;
  }>;
};

interface Question {
  instructions: { thread: { subject: string } };
}

/** query → thread subject → the recorded Noul. */
function recordedJudgments() {
  const dir = new URL("recordings/", fixtures);
  const byQuery = new Map<string, Map<string, number>>();
  for (const file of readdirSync(dir)) {
    const { request, response } = JSON.parse(readFileSync(new URL(file, dir), "utf8")) as {
      request: { state: { query: string }; questions: Record<string, Question> };
      response: { answers: Record<string, { noul: number }> };
    };
    const bySubject = new Map<string, number>();
    for (const [id, question] of Object.entries(request.questions)) {
      bySubject.set(question.instructions.thread.subject, response.answers[id]!.noul);
    }
    byQuery.set(request.state.query, bySubject);
  }
  return byQuery;
}

/** Answers from the recordings, fails, or hangs; a question it has no recording for is a 500. */
async function startJev() {
  const judgments = recordedJudgments();
  const state = { mode: "replay" as "replay" | "fail" | "hang", requests: 0 };
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    state.requests++;
    if (state.mode === "hang") return; // never answers; the Worker has to give up
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      model: string;
      state: { query: string };
      questions: Record<string, Question>;
    };
    const bySubject = judgments.get(body.state.query);
    const answers = Object.entries(body.questions).map(([id, q]) => [
      id,
      bySubject?.get(q.instructions.thread.subject),
    ]);
    if (state.mode === "fail" || answers.some(([, noul]) => noul === undefined)) {
      res.writeHead(500).end("no recording for this request");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        model: body.model,
        answers: Object.fromEntries(answers.map(([id, noul]) => [id, { type: "noul", noul }])),
        usage: { input_tokens: 2_700, output_tokens: 0 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    state,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let jev: Awaited<ReturnType<typeof startJev>>;
let worker: Awaited<ReturnType<typeof startWorker>>;
let cookie: string;
/** Fixture thread id → stored thread id. */
const threadIds = new Map<string, string>();

beforeAll(async () => {
  database = await createTestDatabase();
  mailService = await startMailServiceEndpoint();
  jev = await startJev();
  worker = await startWorker({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    vars: { TYPESAFE_API_URL: jev.url },
    secrets: { TYPESAFE_API_KEY: "recorded" },
  });

  const { db } = database;
  const org = await createOrg(db, "search");
  await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
  const member = await createMember(db, org.id, fixture.mailbox);
  const box = await createMailbox(db, org.id, fixture.mailbox, "personal");
  await grant(db, org.id, box.id, member.id);
  const shift = Date.now() - new Date(fixture.now).getTime();
  let uid = 1;
  for (const thread of fixture.threads) {
    const sentAt = new Date(new Date(thread.sentAt).getTime() + shift);
    const seeded = await seedMessage(db, box, {
      subject: thread.subject,
      fromAddress: thread.from.address,
      fromName: thread.from.name,
      sentAt,
      text: thread.text,
      uid: uid++,
    });
    threadIds.set(thread.id, seeded.threadId);
  }
  // An earlier message in the contract thread that also matches: still one row for the thread.
  await seedMessage(db, box, {
    subject: "Website redesign proposal",
    fromAddress: fixture.mailbox,
    threadId: threadIds.get("brightside-contract-question"),
    sentAt: new Date(Date.now() - 10 * 86_400_000),
    text: "Hi Lena, here is the proposal and the draft contract for the redesign.",
    uid: uid++,
  });
  cookie = await signIn(worker, db, fixture.mailbox);
});

afterAll(async () => {
  await worker?.server.close();
  await jev?.close();
  await mailService?.close();
  await database?.teardown();
});

beforeEach(() => {
  jev.state.mode = "replay";
});

interface SearchResponse {
  ranking: "jev" | "text";
  results: Array<{
    threadId: string;
    subject: string;
    from: { name: string | null; address: string };
    mailboxAddress: string;
    messageCount: number;
    snippet: string;
  }>;
}

async function search(q: string) {
  const started = Date.now();
  const response = await fetch(new URL(`/api/search?q=${encodeURIComponent(q)}`, worker.url), {
    headers: { cookie },
  });
  expect(response.status).toBe(200);
  return { ...((await response.json()) as SearchResponse), ms: Date.now() - started };
}

describe("search", () => {
  test("a typed sentence finds the thread, one row per thread, with a snippet of the match", async () => {
    const { ranking, results } = await search("the invoice from Nightwatch last month");
    expect(ranking).toBe("jev");
    expect(results[0]).toMatchObject({
      threadId: threadIds.get("nightwatch-invoice-oct"),
      subject: "Invoice NW-2291 for October",
      from: { name: "Nightwatch Billing", address: "billing@nightwatch.example" },
      mailboxAddress: fixture.mailbox,
    });
    expect(results[0]!.snippet).toContain("invoice NW-2291");

    const contract = await search("who asked about the contract");
    expect(contract.results[0]).toMatchObject({
      threadId: threadIds.get("brightside-contract-question"),
      // The best-matching message, not the earlier one in the same thread.
      from: { name: "Lena Park" },
      messageCount: 2,
    });
    const ids = contract.results.map((r) => r.threadId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a word that appears only inside sender addresses finds their mail", async () => {
    jev.state.mode = "fail";
    const { results } = await search("lumenhost");
    expect(results.map((r) => r.threadId).toSorted()).toEqual(
      [threadIds.get("lumen-invoice-oct"), threadIds.get("password-reset")].toSorted(),
    );
  });

  test("a repeated search reuses Jev's judgments", async () => {
    const first = await search("nightwatch bill from august");
    const asked = jev.state.requests;
    const again = await search("nightwatch bill from august");
    expect(jev.state.requests).toBe(asked);
    expect(first.results[0]?.threadId).toBe(threadIds.get("nightwatch-invoice-aug"));
    expect(again).toMatchObject({ ranking: "jev", results: first.results });
  });

  test("when Jev fails or hangs, results come back in full-text order within the budget", async () => {
    jev.state.mode = "fail";
    const failed = await search("signed contract");
    expect(failed.ranking).toBe("text");
    expect(failed.results.map((r) => r.threadId)).toContain(
      threadIds.get("brightside-contract-signed"),
    );

    jev.state.mode = "hang";
    const hung = await search("hosting receipt");
    expect(hung.ranking).toBe("text");
    expect(hung.results.map((r) => r.threadId)).toContain(threadIds.get("lumen-invoice-oct"));
    expect(hung.ms).toBeLessThan(4_000);
  });
});
