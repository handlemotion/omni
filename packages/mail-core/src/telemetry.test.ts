import { describe, expect, it } from "vitest";
import { scrubBreadcrumb, scrubEvent } from "./telemetry.ts";

// Each case is a way mail content or a secret could ride an error event out to Sentry.
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
