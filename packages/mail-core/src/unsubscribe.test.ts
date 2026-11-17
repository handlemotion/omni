import { expect, test } from "vitest";
import { unsubscribeMethod } from "./unsubscribe";

test("unsubscribeMethod posts only to an https one-click URI, else mails, else links", () => {
  const mail = "mailto:leave-ab12@lists.example.com?subject=unsubscribe";
  const page = "https://news.example.com/u/ab12";
  expect(unsubscribeMethod([mail, page], true)).toEqual({ kind: "post", url: page });
  expect(unsubscribeMethod([page, mail], false)).toMatchObject({
    kind: "mail",
    to: "leave-ab12@lists.example.com",
  });
  expect(unsubscribeMethod(["http://news.example.com/u/ab12"], true)).toEqual({
    kind: "link",
    url: "http://news.example.com/u/ab12",
  });
  expect(unsubscribeMethod(["javascript:alert(1)", "not a uri"], true)).toBeNull();
});

test("unsubscribeMethod decodes a mailto's address, subject and body, keeping a literal +", () => {
  expect(
    unsubscribeMethod(
      ["mailto:list%2Bleave@example.com,other@example.com?subject=Remove%20me&body=a+b"],
      false,
    ),
  ).toEqual({ kind: "mail", to: "list+leave@example.com", subject: "Remove me", body: "a+b" });
  expect(unsubscribeMethod(["mailto:leave@example.com"], false)).toMatchObject({
    subject: "Unsubscribe",
    body: "",
  });
});
