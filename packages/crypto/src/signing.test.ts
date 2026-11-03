import { describe, expect, it } from "vitest";
import {
  NONCE_HEADER,
  REQUEST_ID_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signRequest,
  verifyRequest,
} from "./index.ts";

const secret = "s".repeat(32);
const now = 1_800_000_000;
const request = {
  method: "POST",
  path: "/internal/mail-actions?mailbox=mbx_1",
  body: '{"action":"archive","threadId":"thr_1"}',
};

async function signed(overrides: { timestamp?: number; nonce?: string; requestId?: string } = {}) {
  return new Headers(await signRequest({ secret, ...request, timestamp: now, ...overrides }));
}

describe("verifyRequest", () => {
  it("accepts a request signed with the same secret", async () => {
    const result = await verifyRequest({ secret, ...request, headers: await signed(), now });
    expect(result).toEqual({ ok: true, timestamp: now, nonce: null, requestId: null });
  });

  it("returns the signed request id", async () => {
    const headers = await signed({ requestId: "req-aaaaaaaa" });
    const result = await verifyRequest({ secret, ...request, headers, now });
    expect(result).toEqual({ ok: true, timestamp: now, nonce: null, requestId: "req-aaaaaaaa" });
  });

  // The request id lands in logs and outbox rows; a forged one would misattribute an action.
  it.each([
    ["swapped", (h: Headers) => h.set(REQUEST_ID_HEADER, "req-bbbbbbbb")],
    ["stripped", (h: Headers) => h.delete(REQUEST_ID_HEADER)],
  ])("rejects a request id %s after signing", async (_, tamper) => {
    const headers = await signed({ requestId: "req-aaaaaaaa" });
    tamper(headers);
    const result = await verifyRequest({ secret, ...request, headers, now });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a request id added to a request signed without one", async () => {
    const headers = await signed();
    headers.set(REQUEST_ID_HEADER, "req-aaaaaaaa");
    const result = await verifyRequest({ secret, ...request, headers, now });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it.each([
    ["body", { body: '{"action":"delete","threadId":"thr_1"}' }],
    ["path", { path: "/internal/mail-actions?mailbox=mbx_2" }],
    ["method", { method: "PUT" }],
  ])("rejects a tampered %s", async (_, change) => {
    const result = await verifyRequest({
      secret,
      ...request,
      ...change,
      headers: await signed(),
      now,
    });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a timestamp moved forward to extend the replay window", async () => {
    const headers = await signed();
    headers.set(TIMESTAMP_HEADER, String(now + 30));
    const result = await verifyRequest({ secret, ...request, headers, now });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a nonce swapped after signing", async () => {
    const headers = await signed({ nonce: "nonce-aaaaaaaaaaaaaaaa" });
    headers.set(NONCE_HEADER, "nonce-bbbbbbbbbbbbbbbb");
    const result = await verifyRequest({ secret, ...request, headers, now });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a nonce stripped after signing", async () => {
    const headers = await signed({ nonce: "nonce-aaaaaaaaaaaaaaaa" });
    headers.delete(NONCE_HEADER);
    const result = await verifyRequest({ secret, ...request, headers, now });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a different secret", async () => {
    const result = await verifyRequest({
      secret: "t".repeat(32),
      ...request,
      headers: await signed(),
      now,
    });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it.each([
    ["past", now - 61],
    ["future", now + 61],
  ])("rejects a %s timestamp outside the window", async (_, timestamp) => {
    const result = await verifyRequest({
      secret,
      ...request,
      headers: await signed({ timestamp }),
      now,
    });
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("accepts skew up to the window edge and honours a custom max age", async () => {
    const headers = await signed({ timestamp: now - 60 });
    expect((await verifyRequest({ secret, ...request, headers, now })).ok).toBe(true);
    expect(await verifyRequest({ secret, ...request, headers, now, maxAgeSeconds: 10 })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects missing or malformed signatures without throwing", async () => {
    const missing = new Headers({ [TIMESTAMP_HEADER]: String(now) });
    expect(await verifyRequest({ secret, ...request, headers: missing, now })).toEqual({
      ok: false,
      reason: "missing_headers",
    });

    const truncated = await signed();
    truncated.set(SIGNATURE_HEADER, (truncated.get(SIGNATURE_HEADER) ?? "").slice(0, 20));
    expect(await verifyRequest({ secret, ...request, headers: truncated, now })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});
