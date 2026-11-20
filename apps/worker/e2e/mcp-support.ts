import { createHash, randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { type CookieJar, WEB_ORIGIN } from "./support.ts";

const BASE = "http://localhost:8787";
const RESOURCE = `${BASE}/mcp`;
const REDIRECT_URI = "http://127.0.0.1:43123/callback";
const NAVIGATION = { accept: "text/html", "sec-fetch-mode": "navigate" };

async function step(response: Response) {
  if (response.status === 302) return new URL(response.headers.get("location")!);
  if (response.status !== 200) throw new Error(`authorize: ${response.status}`);
  return new URL(((await response.json()) as { url: string }).url);
}

/**
 * Signs `jar`'s person in to a fresh OAuth client the way Claude does (dynamic registration,
 * PKCE, consent for `workspace` or every workspace) and returns an MCP client holding the token.
 */
export async function connectAgent(
  workerUrl: string | URL,
  jar: CookieJar,
  options: { scope: string; workspace?: string | null },
) {
  const at = (path: string) => new URL(path, workerUrl);
  const browser = (path: string, init: RequestInit = {}) =>
    fetch(at(path), {
      ...init,
      redirect: "manual",
      headers: { origin: WEB_ORIGIN, cookie: jar.header, ...init.headers },
    });

  const registered = await fetch(at("/api/auth/oauth2/register"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Drive agent",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  const clientId = ((await registered.json()) as { client_id: string }).client_id;
  const verifier = randomBytes(32).toString("base64url");
  const authorize = at("/api/auth/oauth2/authorize");
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: options.scope,
    state: "state-1",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: RESOURCE,
  }).toString();
  const consentPage = await step(
    await browser(authorize.pathname + authorize.search, { headers: NAVIGATION }),
  );
  await browser("/api/oauth/workspace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace: options.workspace ?? null }),
  });
  const consent = await browser("/api/auth/oauth2/consent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accept: true, oauth_query: consentPage.search.slice(1) }),
  });
  const back = new URL(((await consent.json()) as { url: string }).url);
  const token = await fetch(at("/api/auth/oauth2/token"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: back.searchParams.get("code")!,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    }),
  });
  const { access_token } = (await token.json()) as { access_token: string };
  const client = new Client({ name: "e2e-drive-agent", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(at("/mcp"), {
      requestInit: { headers: { authorization: `Bearer ${access_token}` } },
    }),
  );
  return client;
}
