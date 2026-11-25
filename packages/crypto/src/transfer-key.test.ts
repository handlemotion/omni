import { describe, expect, it } from "vitest";
import { signTransferKey, transferOfKey, type TransferGrant } from "./index.ts";

const secret = "s".repeat(32);
const grant: TransferGrant = {
  kind: "get",
  subject: "file-1",
  userId: "user-1",
  scope: null,
  orgId: "org-1",
  ifContentVersion: null,
  expiresAt: new Date(Date.now() + 60_000),
};

describe("transfer keys", () => {
  it("carries the grant it was made for until it expires", async () => {
    const key = await signTransferKey(secret, grant);
    expect(key).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(await transferOfKey(secret, key)).toEqual(grant);
    expect(await transferOfKey(secret, key, new Date(grant.expiresAt.getTime() + 1))).toBeNull();
  });

  it("carries nothing under another secret, with its payload or signature swapped, or edited", async () => {
    const key = await signTransferKey(secret, grant);
    expect(await transferOfKey("t".repeat(32), key)).toBeNull();
    const put = await signTransferKey(secret, { ...grant, kind: "put", subject: "upload-1" });
    const [payload] = key.split(".");
    const [, signature] = put.split(".");
    expect(await transferOfKey(secret, `${payload}.${signature}`)).toBeNull();
    expect(await transferOfKey(secret, `${key}.x`)).toBeNull();
    expect(await transferOfKey(secret, "")).toBeNull();
    expect(await transferOfKey(secret, "a.b")).toBeNull();
  });

  it("keeps a grant through a share, with no workspace, and the version a put replaces", async () => {
    const shared = {
      ...grant,
      orgId: null,
      scope: "org-2",
      kind: "put" as const,
      ifContentVersion: 3,
    };
    expect(await transferOfKey(secret, await signTransferKey(secret, shared))).toEqual(shared);
  });
});
