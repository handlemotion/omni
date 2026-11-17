import { describe, expect, test } from "vitest";
import {
  companyFromAddress,
  domainOf,
  normalizeAddress,
  parseAddress,
  sameAddress,
} from "./addresses.ts";

describe("normalizeAddress", () => {
  test("every spelling of an address is one key", () => {
    const keys = ["ana@acme.com", "Ana@Acme.COM", "  ana@acme.com\n"].map(normalizeAddress);
    expect(new Set(keys)).toEqual(new Set(["ana@acme.com"]));
    expect(sameAddress(" ANA@acme.com", "ana@ACME.com ")).toBe(true);
  });
});

describe("parseAddress", () => {
  test("every spelling of one address, trailing dot included, is one key", () => {
    for (const spelling of ["ana@acme.com", "Ana@Acme.com", " ANA@ACME.COM ", "ana@acme.com."]) {
      expect(parseAddress(spelling)).toBe("ana@acme.com");
    }
  });

  test("an apostrophe, a plus tag and a hyphenated or punycode domain are addresses", () => {
    for (const good of [
      "o'brien@acme.ie",
      "ana+crm@acme.com",
      "a.b@mail.acme-x.co.uk",
      "ana@xn--bcher-kva.de",
    ]) {
      expect(parseAddress(good)).toBe(good);
    }
  });

  test("anything that is not one address is refused", () => {
    for (const bad of [
      "",
      "ana",
      "@acme.com",
      "ana@",
      "ana@@acme.com",
      "a@b@acme.com",
      "ana @acme.com",
      "ana@acme",
      "ana@.acme.com",
      "ana@acme..com",
      "ana@acme.com,bob",
      "<ana@acme.com>",
      "Ana <ana@acme.com>",
      "ana;bob@acme.com",
      '"ana"@acme.com',
      "ana@-acme.com",
      "ana@acme_x.com",
      ".ana@acme.com",
      "ana..b@acme.com",
    ]) {
      expect({ bad, parsed: parseAddress(bad) }).toEqual({ bad, parsed: null });
    }
  });
});

describe("domainOf", () => {
  test("takes the domain after the last @", () => {
    expect(domainOf('"ana@home"@Acme.com')).toBe("acme.com");
  });

  test("an address with no @ or nothing after it has no domain", () => {
    expect(domainOf("MAILER-DAEMON")).toBeNull();
    expect(domainOf("ana@")).toBeNull();
  });
});

describe("companyFromAddress", () => {
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
