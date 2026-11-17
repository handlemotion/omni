import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import { constants, createSecureServer } from "node:http2";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "http2-settings",
  "proxy-connection",
]);

export async function startHttp2Proxy(target: URL) {
  const dir = mkdtempSync(join(tmpdir(), "bench-h2-"));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
    ].concat(["-keyout", key, "-out", cert]),
    { stdio: "ignore" },
  );
  const server = createSecureServer({
    key: readFileSync(key),
    cert: readFileSync(cert),
    allowHTTP1: true,
  });
  rmSync(dir, { recursive: true, force: true });

  server.on("request", (req, res) => {
    const headers: IncomingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!name.startsWith(":") && !HOP_BY_HOP.has(name)) headers[name] = value;
    }
    headers.host = target.host;
    if (headers.origin) headers.origin = target.origin;
    const upstream = request(
      { host: target.hostname, port: target.port, method: req.method, path: req.url, headers },
      (answer) => {
        const out: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(answer.headers)) {
          if (value !== undefined && !HOP_BY_HOP.has(name)) out[name] = value;
        }
        res.writeHead(answer.statusCode ?? 502, out);
        answer.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(constants.HTTP_STATUS_BAD_GATEWAY);
      res.end();
    });
    req.pipe(upstream);
  });

  server.on("upgrade", (req, socket, head) => {
    const upstream = connect(Number(target.port), target.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i]!;
        const lower = name.toLowerCase();
        const value =
          lower === "host"
            ? target.host
            : lower === "origin"
              ? target.origin
              : req.rawHeaders[i + 1];
        lines.push(`${name}: ${value}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  return {
    origin: `https://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
