// Fast, explained DNS checks end to end (ADR 0011): per-record verdicts read from the domain's
// own nameservers (the local authoritative DNS server), and the auto-check that re-checks while
// the DNS page is open and pushes each result over the realtime socket. Real Worker (with its
// Durable Objects and alarms), real mail service, Postgres; nothing mocked.
import { afterAll, beforeAll, expect, test } from "vitest";
import { type OnboardingStack, startOnboardingStack, waitFor } from "./onboarding-stack.ts";
import { WEB_ORIGIN, type CookieJar } from "./support.ts";

let stack: OnboardingStack;
beforeAll(async () => {
  stack = await startOnboardingStack();
});
afterAll(() => stack?.stop());

const api: OnboardingStack["api"] = (...args) => stack.api(...args);
const check = (jar: CookieJar, id: string) => api(jar, "POST", `/onboarding/domains/${id}/check`);
type Challenge = { name: string; value: string; verified: boolean; diagnostic: Diagnostic | null };
type Diagnostic = { status: string; message: string; found: string[] };

test("each check says why the record is not passing yet, from what the nameservers hold now", async () => {
  const a = await stack.workspaceWithClaim();
  const challenge = a.claim.challenge as Challenge;
  // Read at claim time, before anything is published.
  expect(challenge.diagnostic).toMatchObject({ status: "missing", message: "Not found yet." });

  // An earlier value left at the DNS host: shown as found but wrong, with what was found.
  stack.dns.set(challenge.name, "TXT", ["omni-challenge=an-old-value"]);
  expect(((await check(a.jar, a.domainId)).body.challenge as Challenge).diagnostic).toMatchObject({
    status: "wrong_value",
    found: ["omni-challenge=an-old-value"],
  });

  // A CNAME at the name hides any TXT there: the member must remove it first.
  stack.dns.set(challenge.name, "TXT", []);
  stack.dns.set(challenge.name, "CNAME", ["verify.elsewhere.test"]);
  const conflict = await check(a.jar, a.domainId);
  expect((conflict.body.challenge as Challenge).diagnostic).toMatchObject({
    status: "cname_conflict",
    found: ["verify.elsewhere.test"],
  });
  // The verdict is stored: a reload shows it without checking again.
  const status = await api(a.jar, "GET", "/onboarding");
  const listed = (status.body.domains as { id: string; challenge: Challenge }[]).find(
    (d) => d.id === a.domainId,
  );
  expect(listed?.challenge.diagnostic?.status).toBe("cname_conflict");

  // Fixed: the next check verifies it, seconds after the record changed.
  stack.dns.set(challenge.name, "CNAME", []);
  stack.publishChallenge(a.claim);
  expect((await check(a.jar, a.domainId)).body).toMatchObject({
    status: "verified",
    challenge: { verified: true, diagnostic: { status: "ok" } },
  });
});

test("while the DNS page is open, the domain is re-checked on its own and the result is pushed", async () => {
  const a = await stack.workspaceWithClaim();
  const url = new URL("/api/realtime", stack.worker.url);
  url.protocol = "ws:";
  // Node's WebSocket (undici) takes headers: the session cookie and the web app's Origin.
  const socket = new WebSocket(url, {
    headers: { cookie: a.jar.header, origin: WEB_ORIGIN },
  } as unknown as string[]);
  const events: { type: string; domainId?: string }[] = [];
  socket.addEventListener("message", (e) => events.push(JSON.parse(String(e.data))));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("websocket failed to open")));
  });
  try {
    const watched = await api(a.jar, "POST", `/onboarding/domains/${a.domainId}/watch`, {});
    expect(watched).toMatchObject({ status: 200, body: { watching: true } });
    // The first check is about five seconds out: soon enough to feel live, not a flood.
    const firstAt = Date.parse(watched.body.nextCheckAt as string);
    expect(firstAt - Date.now()).toBeGreaterThan(3_000);
    expect(firstAt - Date.now()).toBeLessThanOrEqual(5_000);

    // The member saves the record at their DNS host and does nothing else.
    stack.publishChallenge(a.claim);
    await waitFor(
      async () => events.some((e) => e.type === "domain" && e.domainId === a.domainId),
      15_000,
    );
    const status = await api(a.jar, "GET", "/onboarding");
    expect(
      (status.body.domains as { id: string; status: string }[]).find((d) => d.id === a.domainId),
    ).toMatchObject({ status: "verified" });
    expect((status.body.organization as { setup: string }).setup).toBe("dns_verified");

    // Verified: the watch stops on its own, so no more pushes arrive.
    const pushed = events.length;
    await new Promise((resolve) => setTimeout(resolve, 11_000));
    expect(events.length).toBe(pushed);
  } finally {
    socket.close();
  }
}, 60_000);
