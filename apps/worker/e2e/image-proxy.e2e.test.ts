import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
  grant,
  signIn,
  startMailServiceEndpoint,
  startWorkerWithNetwork,
  SYSTEM_MAIL_FROM,
} from "./support.ts";

// 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorkerWithNetwork>>;
let origin: string;
let originServer: Server;
const originHits: { path: string; headers: IncomingHttpHeaders }[] = [];

/**
 * A real HTTP server standing in for the remote web: images, redirects, and a DNS-over-HTTPS
 * JSON endpoint whose answer for `rebind.example.com` points at loopback.
 */
async function startOrigin() {
  const server = createServer((req, res) => {
    const path = req.url ?? "/";
    originHits.push({ path, headers: req.headers });
    if (path.startsWith("/dns-query")) {
      const name = new URL(path, "http://x").searchParams.get("name");
      const answer = name === "rebind.example.com." || name === "rebind.example.com";
      res.writeHead(200, { "content-type": "application/dns-json" });
      res.end(JSON.stringify({ Answer: answer ? [{ type: 1, data: "127.0.0.1" }] : [] }));
      return;
    }
    const redirect = (to: string) => res.writeHead(302, { location: to }).end();
    switch (path.split("?")[0]) {
      case "/ok.png":
        return res.writeHead(200, { "content-type": "image/png" }).end(PNG);
      case "/logo.svg":
        return res
          .writeHead(200, { "content-type": "image/svg+xml" })
          .end("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
      case "/page":
        return res.writeHead(200, { "content-type": "text/html" }).end("<h1>hi</h1>");
      case "/big.png":
        // No content-length: the cap must hold while streaming.
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(Buffer.alloc(6 * 1024 * 1024));
      case "/to-loopback":
        return redirect("http://127.0.0.1/ok.png");
      case "/to-metadata":
        return redirect("http://169.254.169.254/latest/meta-data/");
      case "/to-ok":
        return redirect("/ok.png");
      case "/loop":
        return redirect("/loop");
      default:
        return res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

beforeAll(async () => {
  database = await createTestDatabase();
  mailService = await startMailServiceEndpoint();
  originServer = await startOrigin();
  origin = `http://127.0.0.1:${(originServer.address() as AddressInfo).port}`;
  worker = await startWorkerWithNetwork({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    vars: { IMAGE_PROXY_TEST_ALLOW_ORIGIN: origin, IMAGE_PROXY_DOH_URL: `${origin}/dns-query` },
  });
});

afterAll(async () => {
  await worker?.close();
  await mailService?.close();
  await new Promise((resolve) => originServer?.close(resolve));
  await database?.teardown();
});

async function member(slug: string) {
  const { db } = database;
  const org = await createOrg(db, slug);
  await createMailbox(db, org.id, SYSTEM_MAIL_FROM);
  const ana = await createMember(db, org.id, `ana@${slug}.test`);
  const bea = await createMember(db, org.id, `bea@${slug}.test`);
  const anaBox = await createMailbox(db, org.id, `ana@${slug}.test`, "personal");
  const beaBox = await createMailbox(db, org.id, `bea@${slug}.test`, "personal");
  await grant(db, org.id, anaBox.id, ana.id);
  await grant(db, org.id, beaBox.id, bea.id);
  return {
    org,
    anaBox,
    anaCookie: await signIn(worker, db, `ana@${slug}.test`),
    beaCookie: await signIn(worker, db, `bea@${slug}.test`),
  };
}

const proxy = (url: string, cookie: string) =>
  fetch(new URL(`/api/image-proxy?url=${encodeURIComponent(url)}`, worker.url), {
    headers: { cookie, referer: "https://app.omni.test/inbox" },
  });

describe("image proxy", () => {
  let cookie: string;
  beforeAll(async () => {
    cookie = (await member("proxy")).anaCookie;
  });

  test("is not an open proxy: it needs a signed-in member", async () => {
    expect((await proxy(`${origin}/ok.png`, "")).status).toBe(401);
  });

  test("refuses private, loopback, link-local and metadata destinations, odd ports and schemes", async () => {
    const refused: [string, number][] = [
      ["http://127.0.0.1/a.png", 403],
      ["http://10.0.0.5/a.png", 403],
      ["http://172.20.1.1/a.png", 403],
      ["http://192.168.1.1/a.png", 403],
      ["http://169.254.169.254/latest/meta-data/", 403],
      ["http://100.64.0.1/a.png", 403],
      ["http://0.0.0.0/a.png", 403],
      ["http://[::1]/a.png", 403],
      ["http://[::ffff:127.0.0.1]/a.png", 403],
      ["http://[fd00::1]/a.png", 403],
      ["http://[fe80::1]/a.png", 403],
      // Numeric forms the URL parser turns into 127.0.0.1.
      ["http://0x7f000001/a.png", 403],
      ["http://2130706433/a.png", 403],
      ["http://localhost/a.png", 403],
      ["http://printer.local/a.png", 403],
      ["http://metadata.google.internal/computeMetadata/v1/", 403],
      // A public name whose DNS answer is loopback (DNS rebinding).
      ["http://rebind.example.com/a.png", 403],
      ["http://93.184.216.34:8080/a.png", 403],
      ["http://user:pass@93.184.216.34/a.png", 403],
      ["file:///etc/passwd", 400],
      ["ftp://93.184.216.34/a.png", 400],
      ["not a url", 400],
    ];
    const hitsBefore = originHits.filter((h) => !h.path.startsWith("/dns-query")).length;
    for (const [url, status] of refused) {
      const response = await proxy(url, cookie);
      expect({ url, status: response.status }).toEqual({ url, status });
    }
    // Nothing above reached a server.
    expect(originHits.filter((h) => !h.path.startsWith("/dns-query")).length).toBe(hitsBefore);
  });

  test("re-checks every redirect hop and bounds the chain", async () => {
    expect((await proxy(`${origin}/to-loopback`, cookie)).status).toBe(403);
    expect((await proxy(`${origin}/to-metadata`, cookie)).status).toBe(403);
    expect((await proxy(`${origin}/loop`, cookie)).status).toBe(403);
    expect((await proxy(`${origin}/to-ok`, cookie)).status).toBe(200);
  });

  test("serves only raster images under the size cap", async () => {
    expect((await proxy(`${origin}/logo.svg`, cookie)).status).toBe(415);
    expect((await proxy(`${origin}/page`, cookie)).status).toBe(415);
    expect((await proxy(`${origin}/big.png`, cookie)).status).toBe(413);
  });

  test("strips the reader's cookies and referrer, locks the response down, and caches it", async () => {
    const response = await proxy(`${origin}/ok.png?fresh=1`, cookie);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("set-cookie")).toBeNull();

    const hits = originHits.filter((h) => h.path === "/ok.png?fresh=1");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.headers.cookie).toBeUndefined();
    expect(hits[0]!.headers.referer).toBeUndefined();

    // Served from the Cache API the second time.
    expect((await proxy(`${origin}/ok.png?fresh=1`, cookie)).status).toBe(200);
    expect(originHits.filter((h) => h.path === "/ok.png?fresh=1")).toHaveLength(1);
  });
});
