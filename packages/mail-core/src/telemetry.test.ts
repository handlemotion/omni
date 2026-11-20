import { describe, expect, it } from "vitest";
import { capEvents, sampleTrace, scrubBreadcrumb, scrubEvent } from "./telemetry.ts";

describe("scrubEvent", () => {
  it("removes addresses from exception messages, like an SMTP rejection", () => {
    const event = scrubEvent({
      exception: {
        values: [
          { type: "Error", value: "550 5.1.1 <luis@client.test>: Recipient address rejected" },
        ],
      },
    });
    expect(JSON.stringify(event)).not.toContain("luis@client.test");
    expect(event.exception).toEqual({
      values: [{ type: "Error", value: "550 5.1.1 <[email]>: Recipient address rejected" }],
    });
  });

  it("redacts content and credential fields at any depth, keeping ids", () => {
    const event = scrubEvent({
      extra: {
        action: {
          id: "act_1",
          payload: { to: ["a@b.test"], text: "the salary numbers" },
          pass: "hunter2",
        },
        mailbox: { id: "mbx_1", credentials_enc: "k1:abc", "Set-Cookie": "session=1" },
      },
      contexts: { state: { cleanText: "hello", MAIL_SERVICE_HMAC_SECRET: "shh-hmac-value" } },
    });
    const text = JSON.stringify(event);
    for (const leak of [
      "salary",
      "hunter2",
      "a@b.test",
      "k1:abc",
      "session=1",
      "hello",
      "shh-hmac-value",
    ]) {
      expect(text).not.toContain(leak);
    }
    expect(text).toContain("act_1");
    expect(text).toContain("mbx_1");
  });

  it("keeps only the user id and the request method and path", () => {
    const event = scrubEvent({
      user: { id: "usr_1", email: "ana@acme.test", ip_address: "203.0.113.9" },
      request: {
        method: "GET",
        url: "https://omni.example/api/search?q=layoffs",
        query_string: "q=layoffs",
        cookies: { session: "s" },
        headers: { cookie: "session=s" },
        data: { text: "draft" },
      },
    });
    expect(event.user).toEqual({ id: "usr_1" });
    expect(event.request).toEqual({ method: "GET", url: "https://omni.example/api/search" });
  });

  it("strips query strings from URLs inside messages and breadcrumbs", () => {
    const crumb = scrubBreadcrumb({
      category: "fetch",
      data: { url: "/api/search?q=board%20meeting", method: "GET", status_code: 200 },
      message: "GET https://omni.example/login?token=abc#x failed",
    });
    expect(crumb?.data?.url).toBe("/api/search");
    expect(crumb?.message).toBe("GET https://omni.example/login failed");
  });

  it("drops the bound values from a database error, which can be a search term", () => {
    const event = scrubEvent({
      exception: {
        values: [
          { value: 'Failed query: select 1 where body @@ $1\nparams: "layoff plans",org_1' },
        ],
      },
    });
    expect(JSON.stringify(event)).not.toContain("layoff");
  });

  it("drops console breadcrumbs", () => {
    expect(scrubBreadcrumb({ category: "console", message: "ana@acme.test" })).toBeNull();
  });
});

describe("sampleTrace", () => {
  const fresh = (rate: number) => rate;

  it.each([
    ["Scheduled Cron * * * * *", 0],
    ["GET /health", 0],
    ["GET /api/realtime", 0],
    ["GET /assets/index-abc.js", 0],
    ["PUT /api/storage/uploads/up_1/parts/3", 0.1],
    ["POST /api/storage/sync/changes", 0.1],
    ["/acme/files/folder/fld_1", 0.1],
    ["/s/shr_1", 0.1],
    ["Scheduled Cron 47 3 * * *", 0.02],
    ["GET /api/threads/thr_1", 0.02],
    ["/acme/mail/inbox", 0.02],
  ])("%s → %s", (name, rate) => {
    expect(sampleTrace({ name, inheritOrSampleWith: fresh })).toBe(rate);
  });

  it("keeps the caller's decision so a web trace continues into the Worker", () => {
    expect(sampleTrace({ name: "GET /api/threads/thr_1", inheritOrSampleWith: () => 1 })).toBe(1);
  });
});

describe("capEvents", () => {
  it("lets the first events through and drops the rest of a storm", () => {
    const cap = capEvents(2);
    expect([1, 2, 3, 4].map((n) => cap({ n }))).toEqual([{ n: 1 }, { n: 2 }, null, null]);
  });
});

describe("sampleTrace with streamed spans' generic names", () => {
  const fresh = (rate: number) => rate;

  it.each([
    [{ normalizedRequest: { method: "GET", url: "https://omni.test/health" } }, 0],
    [
      {
        normalizedRequest: { method: "PUT", url: "https://omni.test/api/storage/uploads/u?part=1" },
      },
      0.1,
    ],
    [{ normalizedRequest: { method: "GET", url: "https://omni.test/api/threads" } }, 0.02],
    [{ location: { pathname: "/acme/files/fld_1" } }, 0.1],
    [{ location: { pathname: "/acme/mail/inbox" } }, 0.02],
    [{ location: { pathname: "/drive/folder/fld_1" } }, 0.1],
  ])("%j → %s", (context, rate) => {
    expect(sampleTrace({ name: "GET", inheritOrSampleWith: fresh, ...context })).toBe(rate);
  });
});
