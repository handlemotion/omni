import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { schema } from "@omni/db";
import { sql } from "drizzle-orm";
import setup from "./global-setup.ts";
import { startStorageStack, type Person, type StorageStack } from "./storage-support.ts";
import { WEB_ORIGIN } from "./support.ts";

const files = Number(process.env.BENCH_FILES ?? 12000);
const folders = Number(process.env.BENCH_FOLDERS ?? 40);
const port = Number(process.env.BENCH_PORT ?? 8790);
let rttMs = Number(process.env.BENCH_RTT_MS ?? 0);

await setup();
const stack = await startStorageStack({
  vars: { WEB_APP_URL: WEB_ORIGIN, RATE_LIMIT_AUTH: "off", RATE_LIMIT_STORAGE_SYNC: "off" },
});
const at = (path: string) => new URL(path, stack.worker.url);

async function nextStep(response: Response) {
  if (response.status === 302) return new URL(response.headers.get("location")!);
  if (response.status !== 200) throw new Error(`sign-in step answered ${response.status}`);
  return new URL(((await response.json()) as { url: string }).url);
}

async function connect(person: Person) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const start = at("/api/storage/sync/authorize");
  start.search = new URLSearchParams({ code_challenge: challenge, state: "s1" }).toString();
  const browser = (url: URL) =>
    fetch(url, {
      redirect: "manual",
      headers: { cookie: person.jar.header, accept: "text/html", "sec-fetch-mode": "navigate" },
    });
  const authorize = await nextStep(await browser(start));
  const back = await nextStep(
    await browser(new URL(authorize.pathname + authorize.search, at("/"))),
  );
  const token = await fetch(at("/api/auth/oauth2/token"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: back.searchParams.get("code")!,
      redirect_uri: "omni://oauth/callback",
      client_id: "omni-desktop",
      code_verifier: verifier,
      resource: authorize.searchParams.get("resource")!,
    }),
  });
  if (token.status !== 200) throw new Error(`token answered ${token.status}`);
  return ((await token.json()) as { access_token: string }).access_token;
}

async function seed(stack: StorageStack, orgId: string, ownerMemberId: string) {
  const base = {
    orgId,
    space: "personal" as const,
    ownerMemberId,
    createdByMemberId: ownerMemberId,
  };
  let revision = 0;
  const folderIds: string[] = [];
  const rows: (typeof schema.storageNodes.$inferInsert)[] = [];
  for (let f = 0; f < folders; f++) {
    const id = randomUUID();
    folderIds.push(id);
    const parentId = f > 0 && f % 4 === 0 ? folderIds[0] : null;
    rows.push({ ...base, id, kind: "folder", name: `Folder ${f}`, parentId, revision: ++revision });
  }
  for (let n = 0; n < files; n++) {
    const id = randomUUID();
    const parentId = n % 20 === 0 ? null : folderIds[n % folders]!;
    rows.push({
      ...base,
      id,
      kind: "file",
      name: `Document ${n}.pdf`,
      parentId,
      size: 1000 + n,
      mimeType: "application/pdf",
      r2Key: `orgs/${orgId}/${id}`,
      contentSha256: createHash("sha256").update(id).digest("hex"),
      revision: ++revision,
    });
  }
  for (let i = 0; i < rows.length; i += 1000) {
    await stack.db.insert(schema.storageNodes).values(rows.slice(i, i + 1000));
  }
  await stack.db
    .insert(schema.storageSyncState)
    .values({ orgId, revision })
    .onConflictDoUpdate({
      target: schema.storageSyncState.orgId,
      set: { revision: sql`greatest(${schema.storageSyncState.revision}, ${revision})` },
    });
}

const company = await stack.company(`bench-${randomUUID().slice(0, 6)}`);
const owner = await stack.member(company.id, "owner");
const picked = await fetch(at("/api/oauth/workspace"), {
  method: "POST",
  headers: { cookie: owner.jar.header, "content-type": "application/json" },
  body: JSON.stringify({ workspace: company.id }),
});
if (picked.status !== 200) throw new Error(`picking the workspace answered ${picked.status}`);
const token = await connect(owner);
await seed(stack, company.id, owner.id);

let counted: Record<string, number> = {};
const upstream = new URL(stack.worker.url);
const proxy = createServer((incoming, outgoing) => {
  if (incoming.url?.startsWith("/__bench/rtt/")) {
    rttMs = Number(incoming.url.slice("/__bench/rtt/".length)) || 0;
    outgoing.end(JSON.stringify({ rttMs }));
    return;
  }
  if (incoming.url === "/__bench/requests") {
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify(counted));
    counted = {};
    return;
  }
  const kind = `${incoming.method} ${(incoming.url ?? "")
    .split("?")[0]!
    .replace("/api/storage/sync", "")
    .replace(/[0-9a-f-]{36}/g, ":id")
    .replace(/parts\/\d+/, "parts/:n")}`;
  counted[kind] = (counted[kind] ?? 0) + 1;
  setTimeout(() => {
    const forward = request(
      {
        host: upstream.hostname,
        port: upstream.port,
        method: incoming.method,
        path: incoming.url,
        headers: { ...incoming.headers, host: upstream.host },
      },
      (answer) => {
        outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(outgoing);
      },
    );
    forward.on("error", () => outgoing.destroy());
    incoming.pipe(forward);
  }, rttMs);
});
await new Promise<void>((resolve) => proxy.listen(port, "127.0.0.1", resolve));

const answer = JSON.stringify({
  origin: `http://127.0.0.1:${port}`,
  token,
  orgId: company.id,
  files,
  folders,
  rttMs,
});
writeFileSync(process.env.BENCH_OUT ?? "sync-bench.json", `${answer}\n`);
process.stdout.write(`${answer}\n`);

const stop = async () => {
  proxy.close();
  await stack.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
