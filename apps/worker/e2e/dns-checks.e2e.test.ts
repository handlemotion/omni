import { afterAll, beforeAll, expect, test } from "vitest";
import { type OnboardingStack, startOnboardingStack, waitFor } from "./onboarding-stack.ts";
import { pushFrame, WEB_ORIGIN, type CookieJar } from "./support.ts";

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
  expect(challenge.diagnostic).toMatchObject({ status: "missing", message: "Not found yet." });

  stack.dns.set(challenge.name, "TXT", ["omni-challenge=an-old-value"]);
  expect(((await check(a.jar, a.domainId)).body.challenge as Challenge).diagnostic).toMatchObject({
    status: "wrong_value",
    found: ["omni-challenge=an-old-value"],
  });

  stack.dns.set(challenge.name, "TXT", []);
  stack.dns.set(challenge.name, "CNAME", ["verify.elsewhere.test"]);
  const conflict = await check(a.jar, a.domainId);
  expect((conflict.body.challenge as Challenge).diagnostic).toMatchObject({
    status: "cname_conflict",
    found: ["verify.elsewhere.test"],
  });
  const status = await api(a.jar, "GET", "/onboarding");
  const listed = (status.body.domains as { id: string; challenge: Challenge }[]).find(
    (d) => d.id === a.domainId,
  );
  expect(listed?.challenge.diagnostic?.status).toBe("cname_conflict");

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
  const socket = new WebSocket(url, {
    headers: { cookie: a.jar.header, origin: WEB_ORIGIN },
  } as unknown as string[]);
  const events: { type: string; domainId?: string }[] = [];
  socket.addEventListener("message", (e) => pushFrame(events, e.data));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("websocket failed to open")));
  });
  try {
    const watched = await api(a.jar, "POST", `/onboarding/domains/${a.domainId}/watch`, {});
    expect(watched).toMatchObject({ status: 200, body: { watching: true } });
    const firstAt = Date.parse(watched.body.nextCheckAt as string);
    expect(firstAt - Date.now()).toBeGreaterThan(3_000);
    expect(firstAt - Date.now()).toBeLessThanOrEqual(5_000);

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

    const watch = await stack.worker.server
      .getWorker()
      .getDurableObjectStorage("DOMAIN_WATCH", { name: a.domainId });
    await waitFor(
      async () =>
        (await watch.exec("SELECT name FROM sqlite_master WHERE name = '_cf_KV'")).length === 0,
    );
  } finally {
    socket.close();
  }
});
