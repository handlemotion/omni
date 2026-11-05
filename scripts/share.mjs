#!/usr/bin/env node
// Shares a server running on this machine at a private HTTPS URL that only your own Tailscale
// devices can open. Each machine (each cloud session) gets its own name, so the URL is new every
// session. Built for Claude Code cloud sessions, where the egress proxy carries Tailscale but not
// ngrok or cloudflared; it runs its own userspace tailscaled, so it never touches a system one.
//
//   pnpm share            the Omni stack: `pnpm stack:serve` with auth on the shared URL
//   pnpm share <port>     any local server, e.g. Vite on 5173
//   pnpm share status     what is shared, and where
//   pnpm share stop       stop sharing and take this machine off the tailnet
//
// URLs are https://<machine>.<tailnet>.ts.net:<port>, the same port as the local server.
// TS_AUTHKEY joins the tailnet without a click: an OAuth client secret (tskey-client-..., tagged
// TS_TAGS, default tag:omni-cloud; the machine is ephemeral) or an auth key (tskey-auth-...). It is
// read from the environment, else from Doppler when DOPPLER_TOKEN is set. Without one, the script
// prints a login link: open it, approve the machine, and run the command again.
// Setup and tailnet policy: docs/operations/cloud-sessions.md.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

const version = "1.104.5";
const tarballSha256 = "720cbbccbfc03d8b55df72afc19e5a72e31b0f65934700aa6fa38074d4ad7bf7";
const omniPort = 8787;

const root = join(import.meta.dirname, "..");
const stateDir = join(root, ".local/tailscale");
const binDir = join(stateDir, `tailscale_${version}_amd64`);
const tailscale = join(binDir, "tailscale");
const tailscaled = join(binDir, "tailscaled");
const socket = join(stateDir, "tailscaled.sock");
const daemonLog = join(stateDir, "tailscaled.log");
const pidFile = join(stateDir, "tailscaled.pid");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** Runs the CLI against our daemon; returns { status, out } with stdout and stderr joined. */
function ts(args, { timeout = 60_000 } = {}) {
  const r = spawnSync(tailscale, [`--socket=${socket}`, ...args], { encoding: "utf8", timeout });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function status() {
  const r = ts(["status", "--json"], { timeout: 10_000 });
  try {
    return JSON.parse(r.out);
  } catch {
    return undefined;
  }
}

function installBinaries() {
  if (existsSync(tailscale) && existsSync(tailscaled)) return;
  if (process.platform !== "linux" || process.arch !== "x64") {
    fail("pnpm share installs Tailscale for linux-x64 only; elsewhere, use your own Tailscale.");
  }
  mkdirSync(stateDir, { recursive: true });
  const tarball = join(stateDir, `tailscale_${version}_amd64.tgz`);
  console.log(`Installing Tailscale ${version} into ${stateDir}`);
  // curl, not fetch: it follows HTTPS_PROXY (the cloud egress proxy) on its own.
  execFileSync("curl", [
    "-fsSL",
    "--retry",
    "3",
    "-o",
    tarball,
    `https://pkgs.tailscale.com/stable/tailscale_${version}_amd64.tgz`,
  ]);
  const sha = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  if (sha !== tarballSha256) {
    rmSync(tarball);
    fail(`Tailscale tarball checksum mismatch (got ${sha})`);
  }
  execFileSync("tar", ["-xzf", tarball, "-C", stateDir]);
  rmSync(tarball);
}

async function startDaemon() {
  if (status()) return;
  mkdirSync(stateDir, { recursive: true });
  const log = openSync(daemonLog, "a");
  // Userspace networking: no TUN device or root, and nothing on this machine can open connections
  // into the tailnet (that would need tailscaled's SOCKS5 proxy, which stays off). Inbound
  // `tailscale serve` traffic is all it carries.
  const child = spawn(
    tailscaled,
    [
      "--tun=userspace-networking",
      `--statedir=${join(stateDir, "state")}`,
      `--socket=${socket}`,
      "--port=0",
    ],
    { detached: true, stdio: ["ignore", log, log] },
  );
  child.unref();
  writeFileSync(pidFile, String(child.pid));
  for (let i = 0; i < 60; i++) {
    if (status()) return;
    await sleep(250);
  }
  fail(`tailscaled did not start; see ${daemonLog}`);
}

/** The auth key, or undefined. Never printed. */
function authKey() {
  if (process.env.TS_AUTHKEY) return process.env.TS_AUTHKEY.trim();
  if (!process.env.DOPPLER_TOKEN) return undefined;
  const r = spawnSync("doppler", ["secrets", "get", "TS_AUTHKEY", "--plain"], {
    encoding: "utf8",
    timeout: 20_000,
  });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
}

/** A DNS label unique to this cloud session (or this machine, outside one). */
function machineName() {
  const id = (process.env.CLAUDE_CODE_REMOTE_SESSION_ID ?? hostname())
    .replace(/^cse_/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return `omni-${id.slice(0, 10) || "dev"}`;
}

/** Brings the machine onto the tailnet; returns its DNS name, or exits with a login link. */
async function connect() {
  let st = status();
  if (st?.BackendState !== "Running") {
    const key = authKey();
    const args = ["up", `--hostname=${machineName()}`, "--accept-dns=false"];
    let keyFile;
    if (key) {
      let value = key;
      if (key.startsWith("tskey-client-")) {
        if (!key.includes("?")) value += "?ephemeral=true&preauthorized=true";
        args.push(`--advertise-tags=${process.env.TS_TAGS ?? "tag:omni-cloud"}`);
      }
      // file: keeps the key out of the process list.
      keyFile = join(stateDir, "authkey");
      writeFileSync(keyFile, value, { mode: 0o600 });
      args.push(`--auth-key=file:${keyFile}`, "--timeout=90s");
    } else {
      args.push("--timeout=15s");
    }
    const r = ts(args, { timeout: 120_000 });
    if (keyFile) rmSync(keyFile, { force: true });
    st = status();
    if (st?.BackendState !== "Running") {
      const link = st?.AuthURL || r.out.match(/https:\/\/login\.tailscale\.com\/\S+/)?.[0];
      if (!key && link) {
        console.log(`Approve this machine on your tailnet, then run the command again:\n  ${link}`);
        process.exit(2);
      }
      // `tailscale up` output names the key's problem, never the key itself.
      fail(`Could not join the tailnet (${st?.BackendState ?? "no daemon"}):\n${r.out}`);
    }
  }
  const dns = st.Self?.DNSName?.replace(/\.$/, "");
  if (!dns) fail("Joined the tailnet but got no MagicDNS name: turn on MagicDNS for the tailnet.");
  return dns;
}

/** Fetches the HTTPS certificate now, so the first page load does not wait on it. */
function ensureCert(dns) {
  const cert = join(stateDir, "cert.pem");
  const key = join(stateDir, "cert.key");
  const r = ts(["cert", `--cert-file=${cert}`, `--key-file=${key}`, dns], { timeout: 120_000 });
  rmSync(cert, { force: true });
  rmSync(key, { force: true });
  if (r.status !== 0) {
    fail(`No HTTPS certificate for ${dns}; turn on HTTPS Certificates for the tailnet.\n${r.out}`);
  }
}

function serve(port) {
  const r = ts(["serve", "--bg", `--https=${port}`, `http://127.0.0.1:${port}`]);
  if (r.status !== 0) fail(`tailscale serve failed:\n${r.out}`);
}

function urlFor(dns, port) {
  return port === 443 ? `https://${dns}/` : `https://${dns}:${port}/`;
}

async function share(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) fail(`Not a port: ${port}`);
  installBinaries();
  await startDaemon();
  const dns = await connect();
  ensureCert(dns);
  serve(port);
  const url = urlFor(dns, port);
  if (port === omniPort) {
    // Restarts the Worker if it runs for another origin; returns once /health answers.
    const r = spawnSync(process.execPath, [join(root, "scripts/serve.mjs"), "start"], {
      env: { ...process.env, PUBLIC_ORIGIN: url.replace(/\/$/, ""), PORT: String(port) },
      stdio: "inherit",
    });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
  console.log(`Shared: ${url}`);
  console.log("Opens on your devices signed in to the tailnet (Tailscale app on).");
}

async function stop() {
  if (!existsSync(tailscale) || !status()) {
    console.log("Not sharing");
    return;
  }
  ts(["serve", "reset"]);
  ts(["logout"]); // An ephemeral machine is deleted; any other is signed out.
  const pid = Number(readFileSync(pidFile, "utf8"));
  try {
    if (pid) process.kill(pid, "SIGTERM");
  } catch {}
  rmSync(pidFile, { force: true });
  console.log("Stopped sharing; this machine left the tailnet");
}

function report() {
  const st = existsSync(tailscale) ? status() : undefined;
  if (st?.BackendState !== "Running") {
    console.log("Not sharing");
    return;
  }
  console.log(ts(["serve", "status"]).out);
}

const arg = process.argv[2];
if (arg === "stop") await stop();
else if (arg === "status") report();
else if (arg === undefined) await share(omniPort);
else if (/^\d+$/.test(arg)) await share(Number(arg));
else fail("usage: pnpm share [port | status | stop]");
