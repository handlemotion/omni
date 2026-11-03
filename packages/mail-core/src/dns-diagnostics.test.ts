import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  type Answers,
  type DnsAnswer,
  detectDnsProvider,
  diagnose,
  domainConnectApplyUrl,
  domainConnectHost,
  domainConnectQuery,
  mergeSpf,
  parseDomainConnectSettings,
} from "./dns-diagnostics.ts";
import { purelymailDnsRecords } from "./domains.ts";

// Recorded answers (fixtures/dns/README.md), read the way the mail service's `node:dns` lookups
// return them: answers of the asked type only, TXT strings joined, hosts without the dot.
const TYPES: Record<string, number> = { TXT: 16, MX: 15, CNAME: 5, NS: 2 };
function recorded(name: string, type: keyof typeof TYPES): DnsAnswer {
  const doh = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "../../../fixtures/dns", `${name}.${type}.json`),
      "utf8",
    ),
  ) as { Status: number; Answer?: { type: number; data: string }[] };
  if (doh.Status === 3) return { status: "nxdomain" };
  const values = (doh.Answer ?? [])
    .filter((a) => a.type === TYPES[type])
    .map((a) =>
      type === "TXT"
        ? [...a.data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join("")
        : a.data.toLowerCase().replace(/\.$/, ""),
    );
  return values.length > 0 ? { status: "found", values } : { status: "nodata" };
}
const settings = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../../../fixtures/dns/cloudflare.domainconnect-settings.json"),
    "utf8",
  ),
) as unknown;

// What Purelymail asks a domain to carry, as onboarding shows it.
const want = (domain: string, check: string) =>
  purelymailDnsRecords(domain, "purelymail_ownership_proof=abc").find((r) => r.check === check)!;

describe("diagnose: records that already exist", () => {
  // A second SPF record makes receivers ignore both: SPF fails and mail lands in spam.
  test("an existing SPF record is merged, never doubled", () => {
    const spf = want("google.com", "spf");
    const verdict = diagnose(spf, {
      TXT: recorded("google.com", "TXT"),
      CNAME: { status: "nodata" },
    });
    expect(verdict).toMatchObject({
      status: "spf_merge",
      found: ["v=spf1 include:_spf.google.com ~all"],
      suggestion: "v=spf1 include:_spf.google.com include:_spf.purelymail.com ~all",
    });
  });

  test("two SPF records are flagged, with the one record that replaces them", () => {
    const txt = recorded("google.com", "TXT") as { status: "found"; values: string[] };
    const doubled: Answers = {
      TXT: { status: "found", values: [...txt.values, "v=spf1 include:mailgun.org -all"] },
    };
    expect(diagnose(want("google.com", "spf"), doubled)).toMatchObject({
      status: "spf_multiple",
      suggestion:
        "v=spf1 include:_spf.google.com include:mailgun.org include:_spf.purelymail.com ~all",
    });
  });

  // Telling someone their MX is "missing" when it points at their current host hides that mail
  // moves the moment they change it.
  test("MX pointing at another host says mail moves, and shows where it goes now", () => {
    const verdict = diagnose(want("google.com", "mx"), {
      MX: recorded("google.com", "MX"),
      CNAME: { status: "nodata" },
    });
    expect(verdict).toMatchObject({ status: "mx_elsewhere", found: ["10 smtp.google.com"] });
    expect(verdict.message).toContain("new mail arrives in Omni");
  });

  test("our MX alongside others still splits mail", () => {
    const verdict = diagnose(want("acme.test", "mx"), {
      MX: { status: "found", values: ["50 mailserver.purelymail.com", "10 smtp.google.com"] },
    });
    expect(verdict).toMatchObject({ status: "mx_extra", found: ["10 smtp.google.com"] });
  });

  // www.github.com is a CNAME: a TXT or MX added beside it is rejected or ignored by DNS hosts.
  test("a CNAME at a name that needs TXT is a conflict, whatever the CNAME's target holds", () => {
    const ownership = { ...want("www.github.com", "ownership") };
    const verdict = diagnose(ownership, {
      // c-ares follows the CNAME, so the TXT query returns github.com's records.
      TXT: recorded("www.github.com", "TXT"),
      CNAME: recorded("www.github.com", "CNAME"),
    });
    expect(verdict).toMatchObject({ status: "cname_conflict", found: ["github.com"] });
  });

  test("a CNAME to the wrong target shows the target found", () => {
    const dkim = want("github.com", "dkim");
    const verdict = diagnose(
      { ...dkim, name: "www.github.com" },
      { CNAME: recorded("www.github.com", "CNAME"), TXT: { status: "nodata" } },
    );
    expect(verdict).toMatchObject({ status: "wrong_value", found: ["github.com"] });
  });
});

describe("diagnose: values", () => {
  // google.com carries a dozen unrelated `x=y` verifications; calling them "wrong" would tell
  // the member to delete records other services need.
  test("unrelated TXT records at the name read as not found, not wrong", () => {
    expect(
      diagnose(want("google.com", "ownership"), {
        TXT: recorded("google.com", "TXT"),
        CNAME: { status: "nodata" },
      }),
    ).toMatchObject({ status: "missing", found: [] });
  });

  test("an earlier challenge value is shown as wrong, compared by hash, not text", () => {
    const record = {
      type: "TXT" as const,
      name: "_omni-challenge.acme.test",
      value: "omni-challenge=",
    };
    const answers: Answers = {
      TXT: { status: "found", values: ["omni-challenge=old-value"] },
      CNAME: { status: "nxdomain" },
    };
    expect(diagnose(record, answers, { matched: false })).toMatchObject({
      status: "wrong_value",
      found: ["omni-challenge=old-value"],
    });
    expect(diagnose(record, answers, { matched: true }).status).toBe("ok");
  });

  test("a nameserver that does not answer gives no verdict", () => {
    expect(
      diagnose(want("acme.test", "mx"), { MX: { status: "error", code: "ETIMEOUT" } }).status,
    ).toBe("unknown");
  });
});

describe("mergeSpf", () => {
  // The existing policy (here a strict -all) is the domain owner's choice: keep it.
  test("keeps the first record's all, drops duplicates", () => {
    expect(
      mergeSpf(
        ["v=spf1 ip4:192.0.2.1 include:_spf.purelymail.com -all"],
        ["include:_spf.purelymail.com"],
      ),
    ).toBe("v=spf1 ip4:192.0.2.1 include:_spf.purelymail.com -all");
  });
});

describe("detectDnsProvider", () => {
  test("knows the host from its nameservers", () => {
    const ns = (name: string) => (recorded(name, "NS") as { values: string[] }).values;
    expect(detectDnsProvider(ns("discord.com"))?.id).toBe("cloudflare");
    // Mixed NS1 and Route 53: the one we have steps for.
    expect(detectDnsProvider(ns("github.com"))?.id).toBe("route53");
    expect(detectDnsProvider(["ns0.wikimedia.org"])).toBeNull();
  });
});

describe("Domain Connect", () => {
  // A wrong discovery result sends the member to a URL that is not their DNS host.
  test("discovers the host's API from _domainconnect, and nothing where there is none", () => {
    const found = recorded("_domainconnect.discord.com", "TXT") as { values: string[] };
    expect(domainConnectHost(found.values)).toBe("api.cloudflare.com/client/v4/dns/domainconnect");
    expect(recorded("_domainconnect.namecheap.com", "TXT")).toEqual({ status: "nxdomain" });
    expect(domainConnectHost(["not a host!"])).toBeNull();
  });

  test("reads the settings and builds the apply URL the standard defines", () => {
    const parsed = parseDomainConnectSettings(settings);
    expect(parsed).toEqual({
      providerId: "cloudflare.com",
      providerName: "cloudflare",
      urlSyncUX: "https://dash.cloudflare.com/domainconnect",
      urlAPI: "https://api.cloudflare.com/client/v4/dns/domainconnect",
    });
    expect(
      parseDomainConnectSettings({ ...(settings as object), urlSyncUX: "http://x" }),
    ).toBeNull();
    const query = domainConnectQuery({
      domain: "acme.com",
      host: "mail",
      params: { challenge: "omni-challenge=a+b/c" },
      redirectUri: "https://inbox.example.com/onboarding",
      state: "claim-1",
    });
    expect(query).toBe(
      "domain=acme.com&host=mail&challenge=omni-challenge%3Da%2Bb%2Fc&redirect_uri=https%3A%2F%2Finbox.example.com%2Fonboarding&state=claim-1",
    );
    expect(
      domainConnectApplyUrl({
        settings: parsed!,
        providerId: "omni.example",
        serviceId: "verify",
        query,
        signature: { sig: "s/g==", keyHost: "_dck1" },
      }),
    ).toBe(
      `https://dash.cloudflare.com/domainconnect/v2/domainTemplates/providers/omni.example/services/verify/apply?${query}&sig=s%2Fg%3D%3D&key=_dck1`,
    );
  });
});
