import { describe, expect, test } from "vitest";
import { companyFromAddress, domainOf, normalizeAddress, sameAddress } from "./addresses.ts";

describe("normalizeAddress", () => {
  // A Storage grant, a sign-in email and a CRM person join on this form: if one module kept the
  // case someone typed, a grant to "Ana@Acme.com" would never reach the person signing in as
  // "ana@acme.com".
  test("every spelling of an address is one key", () => {
    const keys = ["ana@acme.com", "Ana@Acme.COM", "  ana@acme.com\n"].map(normalizeAddress);
    expect(new Set(keys)).toEqual(new Set(["ana@acme.com"]));
    expect(sameAddress(" ANA@acme.com", "ana@ACME.com ")).toBe(true);
  });
});

describe("domainOf", () => {
  // A quoted local part may hold an "@"; the domain is after the last one, or a company would be
  // keyed by part of someone's mailbox name.
  test("takes the domain after the last @", () => {
    expect(domainOf('"ana@home"@Acme.com')).toBe("acme.com");
  });

  // Without this, a malformed sender ("MAILER-DAEMON") became a company domain of its own.
  test("an address with no @ or nothing after it has no domain", () => {
    expect(domainOf("MAILER-DAEMON")).toBeNull();
    expect(domainOf("ana@")).toBeNull();
  });
});

describe("companyFromAddress", () => {
  // Every gmail.com sender would otherwise be one "Gmail" company in the helpdesk and the CRM.
  test("webmail stands for no company, in any case", () => {
    expect(companyFromAddress("ana@Gmail.com")).toEqual({ domain: null, company: null });
    expect(companyFromAddress("MAILER-DAEMON")).toEqual({ domain: null, company: null });
  });

  test("names the company from the label before the public suffix", () => {
    expect(companyFromAddress("ana@acme.com")).toEqual({ domain: "acme.com", company: "Acme" });
    expect(companyFromAddress("ana@mail.acme.co.uk")).toEqual({
      domain: "mail.acme.co.uk",
      company: "Acme",
    });
  });
});
