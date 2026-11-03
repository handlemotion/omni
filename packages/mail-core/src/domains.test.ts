import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  mailboxAddress,
  normalizeDomain,
  purelymailDnsRecords,
  purelymailDomainState,
} from "./domains.ts";

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, "../../../fixtures/purelymail", name), "utf8"),
  ) as { result: unknown };

describe("normalizeDomain", () => {
  // `mail_domains.domain` is unique: if two spellings of one domain normalized differently, a
  // second workspace could claim a domain another one already owns.
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

  // These would reach Purelymail's addDomain as garbage, or claim a host that is not a domain.
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

describe("mailboxAddress", () => {
  test("accepts a local part or a full address on the same domain", () => {
    expect(mailboxAddress(" Rodrigo ", "acme.com")).toBe("rodrigo@acme.com");
    expect(mailboxAddress("hello@ACME.com", "acme.com")).toBe("hello@acme.com");
    expect(mailboxAddress("first.last", "acme.com")).toBe("first.last@acme.com");
  });

  // A full address on another domain would create a mailbox on a domain the workspace does not own.
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
  // Purelymail's docs: on a subdomain the DKIM names move under it. Relative names would point
  // DKIM at the parent domain's keys and DKIM would never pass.
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

  // Matching the wrong entry (or none, when Purelymail echoes a different case) would show a
  // verified domain as waiting forever, or the reverse.
  test("reads the entry for this domain whatever its case", () => {
    expect(purelymailDomainState(result, "acme.com")).toEqual({
      added: true,
      checks: { ownership: true, mx: true, spf: true, dkim: false, dmarc: false },
    });
    expect(purelymailDomainState(result, "mail.example.org").checks.dkim).toBe(true);
  });

  test("a domain not on the account has proven nothing", () => {
    const state = purelymailDomainState(result, "example.org");
    expect(state.added).toBe(false);
    expect(Object.values(state.checks)).not.toContain(true);
  });

  // A renamed field must fail loudly, not read as `false` and leave the user waiting on DNS.
  test("an answer of another shape is an error", () => {
    expect(() => purelymailDomainState({}, "acme.com")).toThrow(TypeError);
    expect(() =>
      purelymailDomainState({ domains: [{ name: "acme.com", dnsSummary: {} }] }, "acme.com"),
    ).toThrow(/passesMx/);
  });
});
