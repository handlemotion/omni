import { describe, expect, it } from "vitest";
import { linkSegments } from "./links.ts";

const links = (text: string) => linkSegments(text).filter((s) => s.href);

describe("linkSegments", () => {
  it("links the sign-in URL in Omni's own magic-link email, query string intact", () => {
    const url =
      "https://omnidirectional.app/api/auth/magic-link/verify?token=abc&callbackURL=omni%3A%2F%2Fauth%3Fstate%3D1";
    const text = `Open this link to sign in to Omnidirectional:\n\n${url}\n\nIf you did not ask for it, ignore this email.`;
    expect(links(text)).toEqual([{ text: url, href: url }]);
    // Nothing is lost or reordered around the link.
    expect(
      linkSegments(text)
        .map((s) => s.text)
        .join(""),
    ).toBe(text);
  });

  it("leaves sentence punctuation and wrapping brackets out of the link", () => {
    expect(links("See https://a.example/x.").map((s) => s.text)).toEqual(["https://a.example/x"]);
    expect(links("(docs: https://a.example/y)").map((s) => s.text)).toEqual([
      "https://a.example/y",
    ]);
    expect(links("Google <https://google.com/a>").map((s) => s.text)).toEqual([
      "https://google.com/a",
    ]);
  });

  it("keeps a closing bracket that belongs to the URL", () => {
    expect(links("https://en.wikipedia.org/wiki/Mail_(protocol)").map((s) => s.text)).toEqual([
      "https://en.wikipedia.org/wiki/Mail_(protocol)",
    ]);
  });

  it("never links other schemes or a bare scheme", () => {
    expect(links("javascript:alert(1) data:text/html,x ftp://a.example https://")).toEqual([]);
    // A URL's own text can't smuggle in markup: the href is the parsed, encoded URL.
    expect(links('https://a.example/"><img src=x>')).toEqual([
      { text: "https://a.example/", href: "https://a.example/" },
    ]);
  });
});
