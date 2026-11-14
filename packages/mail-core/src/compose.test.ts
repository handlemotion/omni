import { describe, expect, test } from "vitest";
import { forwardBody, forwardSubject, replyRecipients, replySubject } from "./compose";

test("reply and forward subjects never stack a prefix a client already added, in any case or language", () => {
  // Bug caught: "Re: RE: Invoice" after an Outlook reply, "Fwd: FW: Invoice" after an Outlook forward.
  expect(replySubject("RE: Invoice")).toBe("RE: Invoice");
  expect(replySubject("Aw: Rechnung")).toBe("Aw: Rechnung");
  expect(replySubject("Invoice")).toBe("Re: Invoice");
  expect(forwardSubject("FW: Invoice")).toBe("FW: Invoice");
  expect(forwardSubject("Fwd: Invoice")).toBe("Fwd: Invoice");
  // A reply being forwarded is still a forward.
  expect(forwardSubject("Re: Invoice")).toBe("Fwd: Re: Invoice");
});

test("a forward's HTML escapes the original's sender, subject and text", () => {
  // Bug caught: a display name like `<img src=x onerror=...>` becoming live markup in the
  // HTML we send to a third party under the inbox's name.
  const { text, html } = forwardBody(
    { text: "FYI, see below.", html: "<p>FYI, see below.</p>" },
    {
      fromName: '<img src=x onerror="alert(1)">',
      fromAddress: "luis@client.test",
      to: [{ name: null, address: "hello@acme.test" }],
      cc: [],
      sentAt: new Date("2026-11-01T10:00:00Z"),
      subject: "<b>Refund</b>",
      text: "Order #12 & #13 <please>",
    },
  );
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<b>Refund");
  expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &lt;luis@client.test&gt;");
  expect(html).toContain("Order #12 &amp; #13 &lt;please&gt;");
  // The text part carries the same block verbatim, after what the sender wrote.
  expect(text).toBe(
    [
      "FYI, see below.",
      "",
      "---------- Forwarded message ---------",
      'From: <img src=x onerror="alert(1)"> <luis@client.test>',
      "Date: Sun, 01 Nov 2026 10:00:00 GMT",
      "Subject: <b>Refund</b>",
      "To: hello@acme.test",
      "",
      "Order #12 & #13 <please>",
    ].join("\n"),
  );
});

describe("replyRecipients", () => {
  const self = "Help@Acme.test";
  // Catches: a reply to our own last message going to ourselves instead of the customer.
  test("replying to our own message goes to the people it went to", () => {
    expect(
      replyRecipients(
        { fromAddress: "help@acme.test", to: [{ address: "ana@x.test" }], cc: [] },
        self,
        false,
      ),
    ).toEqual({ to: ["ana@x.test"], cc: [] });
  });
  // Catches: reply all cc'ing our own address, or the sender twice.
  test("reply all copies everyone else once, never ourselves", () => {
    expect(
      replyRecipients(
        {
          fromAddress: "ana@x.test",
          to: [{ address: "help@acme.test" }, { address: "bo@x.test" }],
          cc: [{ address: "ana@x.test" }, { address: "cy@x.test" }],
        },
        self,
        true,
      ),
    ).toEqual({ to: ["ana@x.test"], cc: ["bo@x.test", "cy@x.test"] });
  });
});
