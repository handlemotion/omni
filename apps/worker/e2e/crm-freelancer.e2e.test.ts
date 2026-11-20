import { afterAll, beforeAll, expect, test } from "vitest";
import { type OnboardingStack, startOnboardingStack } from "./onboarding-stack.ts";
import { authPost, CookieJar, signIn, WEB_ORIGIN } from "./support.ts";

let stack: OnboardingStack;
beforeAll(async () => {
  stack = await startOnboardingStack();
});
afterAll(() => stack?.stop());

const api: OnboardingStack["api"] = (...args) => stack.api(...args);

async function put(jar: CookieJar, path: string, body: unknown) {
  const response = await fetch(new URL(`/api${path}`, stack.worker.url), {
    method: "PUT",
    headers: { cookie: jar.header, origin: WEB_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("a freelancer invited as one sees only their project over HTTP, in the CRM and in Drive", async () => {
  const owner = await stack.workspaceWithDomain();
  const email = `fran-${crypto.randomUUID().slice(0, 8)}@freelance.test`;
  const invited = await api(owner.jar, "POST", "/workspace/invitations", {
    email,
    role: "freelancer",
  });
  expect(invited.status).toBe(200);
  expect(invited.body.invitation).toMatchObject({ role: "freelancer" });

  const deal = async (name: string) =>
    (
      (await api(owner.jar, "POST", "/crm/deals", { name, valueMinor: 900_000, currency: "USD" }))
        .body.deal as { id: string }
    ).id;
  const website = await deal("Website");
  const app = await deal("App");
  const added = await put(owner.jar, `/crm/deals/${website}/access/${encodeURIComponent(email)}`, {
    scope: "freelancer",
  });
  expect(added.status).toBe(201);
  expect(added.body.access).toMatchObject([{ email, scope: "freelancer" }]);

  const jar = new CookieJar();
  await signIn(stack.worker, stack.database.db, email, jar);
  const invitationId = (invited.body.invitation as { id: string }).id;
  expect(
    (await authPost(stack.worker, jar, "/organization/accept-invitation", { invitationId })).status,
  ).toBe(200);
  await authPost(stack.worker, jar, "/organization/set-active", { organizationId: owner.orgId });

  const deals = await api(jar, "GET", "/crm/deals");
  expect((deals.body.deals as { name: string }[]).map((d) => d.name)).toEqual(["Website"]);
  expect(deals.body.deals).toMatchObject([{ valueMinor: null, valueCurrency: null }]);
  const opened = await api(jar, "GET", `/crm/deals/${website}`);
  expect(opened.body).toMatchObject({
    deal: { valueMinor: null, valueCurrency: null },
    contracts: [],
  });
  const byValue = await api(jar, "GET", "/crm/deals?minValue=1000000");
  expect((byValue.body.deals as unknown[]).length).toBe(1);
  expect((await api(jar, "GET", `/crm/deals/${website}/plan`)).status).toBe(200);
  expect((await api(jar, "GET", `/crm/deals/${app}`)).status).toBe(404);
  expect((await api(jar, "GET", `/crm/deals/${app}/plan`)).status).toBe(404);
  expect((await api(jar, "GET", `/crm/deals/${app}/timeline`)).status).toBe(404);
  expect((await api(jar, "GET", "/crm/companies")).status).toBe(404);
  expect((await api(jar, "POST", "/crm/deals", { name: "Mine" })).status).toBe(404);
  expect((await api(jar, "GET", `/crm/deals/${website}/access`)).status).toBe(404);

  expect((await api(jar, "GET", "/storage/nodes?space=shared")).status).toBe(404);
  const shared = await api(jar, "GET", "/storage/shared-with-me");
  expect(shared.status).toBe(200);
  expect((shared.body.items as { node: { name: string } }[]).map((i) => i.node.name)).toEqual([
    "Website",
  ]);
});
