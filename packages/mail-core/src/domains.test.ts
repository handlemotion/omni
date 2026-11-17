import { readFileSync } from "node:fs";
import { join } from "node:path";
import { domainToASCII } from "node:url";
import { describe, expect, test } from "vitest";
import {
  mailboxAddress,
  normalizeDomain,
  parentDomains,
  parseDomain,
  purelymailDnsRecords,
  purelymailDomainState,
  purelymailUsernameProblem,
} from "./domains.ts";

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, "../../../fixtures/purelymail", name), "utf8"),
  ) as { result: unknown };

describe("normalizeDomain", () => {
  test("every spelling of a domain claims the same row", () => {
    for (const spelling of [
      "acme.com",
      "ACME.com",
      " acme.com. ",
      "@acme.com",
      "https://Acme.com/",
      "http://acme.com/contact?x=1",
    ]) {
      expect({ spelling, domain: normalizeDomain(spelling) }).toEqual({
        spelling,
        domain: "acme.com",
      });
    }
    expect(normalizeDomain("bücher.de")).toBe(normalizeDomain("xn--bcher-kva.de"));
  });

  test("refuses what is not a domain", () => {
    for (const input of [
      "",
      "acme",
      "localhost",
      "-acme.com",
      "acme-.com",
      "a..com",
      "user@acme.com",
      "acme.com:25",
      "10.0.0.1",
      "acme .com",
    ]) {
      expect({ input, domain: normalizeDomain(input) }).toEqual({ input, domain: null });
    }
  });
});

describe("parseDomain: internationalized names", () => {
  test("accepts names written in one script, and the script mixes languages use", () => {
    for (const name of [
      "bücher.de",
      "пример.рф",
      "例え.jp",
      "東京ディズニー.jp",
      "한국.kr",
      "παράδειγμα.gr",
    ]) {
      expect({ name, ok: "domain" in parseDomain(name) }).toEqual({ name, ok: true });
    }
  });

  test("refuses mixed-script and whole-script lookalikes", () => {
    for (const name of [
      "pаypal.com",
      "gооgle.com",
      "аррӏе.com",
      "αpple.com",
      "xn--pypal-4ve.com",
    ]) {
      const parsed = parseDomain(name);
      expect({ name, refused: "error" in parsed }).toEqual({ name, refused: true });
    }
    expect(parseDomain("аррӏе.рф")).toEqual({ domain: domainToASCII("аррӏе.рф") });
  });

  test("refuses punycode that does not decode", () => {
    expect(parseDomain("xn--zz.com")).toEqual({ error: "that domain name is not valid punycode" });
  });
});

describe("parentDomains", () => {
  test("lists every claimable domain above, nearest first", () => {
    expect(parentDomains("a.mail.acme.co.uk")).toEqual(["mail.acme.co.uk", "acme.co.uk", "co.uk"]);
    expect(parentDomains("acme.com")).toEqual([]);
  });
});

describe("mailboxAddress", () => {
  test("accepts a local part or a full address on the same domain", () => {
    expect(mailboxAddress(" Rodrigo ", "acme.com")).toBe("rodrigo@acme.com");
    expect(mailboxAddress("hello@ACME.com", "acme.com")).toBe("hello@acme.com");
    expect(mailboxAddress("first.last", "acme.com")).toBe("first.last@acme.com");
  });

  test("refuses another domain and local parts mail hosts mangle", () => {
    for (const input of ["rodrigo@other.com", "a+b", ".a", "a.", "a..b", "a b", "", "@"]) {
      expect({ input, address: mailboxAddress(input, "acme.com") }).toEqual({
        input,
        address: null,
      });
    }
  });
});

describe("purelymailDnsRecords", () => {
  test("subdomain records are named under the subdomain", () => {
    const records = purelymailDnsRecords("mail.acme.com", "proof");
    expect(records.filter((r) => r.check === "dkim").map((r) => r.name)).toEqual([
      "purelymail1._domainkey.mail.acme.com",
      "purelymail2._domainkey.mail.acme.com",
      "purelymail3._domainkey.mail.acme.com",
    ]);
    expect(records.find((r) => r.check === "dmarc")?.name).toBe("_dmarc.mail.acme.com");
    expect(records.find((r) => r.check === "ownership")).toMatchObject({
      type: "TXT",
      name: "mail.acme.com",
      value: "proof",
    });
  });
});

describe("purelymailDomainState", () => {
  const { result } = fixture("list-domains.json");

  test("reads the entry for this domain whatever its case", () => {
    expect(purelymailDomainState(result, "acme.com")).toEqual({
      added: true,
      checks: { ownership: true, mx: true, spf: true, dkim: false, dmarc: false },
      symbolicSubaddressing: true,
    });
    expect(purelymailDomainState(result, "mail.example.org").checks.dkim).toBe(true);
  });

  test("a domain not on the account has proven nothing", () => {
    const state = purelymailDomainState(result, "example.org");
    expect(state.added).toBe(false);
    expect(Object.values(state.checks)).not.toContain(true);
  });

  test("an answer of another shape is an error", () => {
    expect(() => purelymailDomainState({}, "acme.com")).toThrow(TypeError);
    expect(() =>
      purelymailDomainState({ domains: [{ name: "acme.com", dnsSummary: {} }] }, "acme.com"),
    ).toThrow(/passesMx/);
  });
});

describe("purelymailUsernameProblem", () => {
  test("refuses names with a symbol only where the domain reads symbols as tags", () => {
    for (const address of ["first.last@acme.com", "support-team@acme.com", "a_b@acme.com"]) {
      expect(purelymailUsernameProblem(address, true)).toMatch(/Use only letters and digits/);
      expect(purelymailUsernameProblem(address, false)).toBeNull();
    }
    expect(purelymailUsernameProblem("hello2@acme.com", true)).toBeNull();
  });
});
