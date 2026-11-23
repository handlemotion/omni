import { randomBytes } from "node:crypto";
import { STORAGE_PART_BYTES } from "@omni/contracts";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  startStorageStack,
  type Person,
  type StorageStack,
} from "../../../apps/worker/e2e/storage-support.ts";
import {
  ApiError,
  createApi,
  createCall,
  createUploadDoor,
  partError,
  runUpload,
  Slots,
  type UploadNetwork,
  type UploadPlace,
} from "../src/index.ts";

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({});
});
afterAll(() => stack?.stop());

const network: UploadNetwork = { online: async () => {}, offline: () => false };

async function person() {
  const org = await stack.company(`client-uploads-${crypto.randomUUID().slice(0, 8)}`);
  return stack.member(org.id);
}

function upload(
  who: Person,
  bytes: Uint8Array,
  options: {
    place?: UploadPlace;
    replaces?: string;
    ifContentVersion?: number;
    resumeId?: string;
    sent?: number[];
    beforePart?: () => Promise<void>;
  } = {},
) {
  const api = createApi({ baseUrl: String(stack.worker.url), headers: { cookie: who.jar.header } });
  return runUpload({
    door: createUploadDoor(api, createCall()),
    file: { name: "file.bin", size: bytes.length, mimeType: "application/octet-stream" },
    place: options.place ?? { space: "personal" },
    replaces: options.replaces,
    ifContentVersion: options.ifContentVersion,
    resumeId: options.resumeId,
    signal: new AbortController().signal,
    onOpened: () => {},
    onProgress: () => {},
    slots: new Slots(4),
    partsAtOnce: 2,
    network,
    part: async ({ n, start, length, url }) => {
      await options.beforePart?.();
      options.sent?.push(n);
      const body = bytes.slice(start, start + length);
      return {
        send: async (signal) => {
          const sent = await fetch(url, {
            method: "PUT",
            headers: { cookie: who.jar.header },
            body,
            signal,
          });
          if (!sent.ok) {
            throw partError(sent.status, await sent.json(), sent.headers.get("retry-after"));
          }
          await sent.body?.cancel();
        },
      };
    },
  });
}

const downloaded = async (who: Person, id: string) =>
  Buffer.from(await (await stack.download(who.jar, id)).arrayBuffer());

test("a file in two parts goes up, and the node it becomes holds exactly its bytes", async () => {
  const who = await person();
  const bytes = randomBytes(STORAGE_PART_BYTES + 1000);
  const sent: number[] = [];

  const node = await upload(who, bytes, { sent });

  expect(sent.toSorted()).toEqual([1, 2]);
  expect(node.size).toBe(bytes.length);
  expect((await downloaded(who, node.id)).equals(bytes)).toBe(true);
});

test("resuming an upload sends only the parts the server lacks", async () => {
  const who = await person();
  const bytes = randomBytes(STORAGE_PART_BYTES + 1000);
  const opened = await stack.api(who.jar, "POST", "/uploads", {
    name: "file.bin",
    size: bytes.length,
    space: "personal",
  });
  const uploadId = String(opened.body.upload.id);
  const first = await stack.putPart(who.jar, uploadId, 1, bytes.subarray(0, STORAGE_PART_BYTES));
  expect(first.status).toBe(200);
  await first.body?.cancel();
  const sent: number[] = [];

  const node = await upload(who, bytes, { resumeId: uploadId, sent });

  expect(sent).toEqual([2]);
  expect(node.id).toBe(uploadId);
  expect((await downloaded(who, node.id)).equals(bytes)).toBe(true);
});

test("a new version made from a stale contentVersion is refused, when opened or when completed", async () => {
  const who = await person();
  const file = await upload(who, Buffer.from("first"));
  const second = await upload(who, Buffer.from("second"), {
    replaces: file.id,
    ifContentVersion: file.contentVersion,
  });
  expect(second.contentVersion).toBeGreaterThan(Number(file.contentVersion));

  const staleOpen = await upload(who, Buffer.from("stale"), {
    replaces: file.id,
    ifContentVersion: file.contentVersion,
  }).catch((error: unknown) => error);
  expect(staleOpen).toBeInstanceOf(ApiError);
  expect((staleOpen as ApiError).code).toBe("version_conflict");

  const staleComplete = await upload(who, Buffer.from("late"), {
    replaces: file.id,
    ifContentVersion: second.contentVersion,
    beforePart: async () => {
      await upload(who, Buffer.from("meanwhile"), { replaces: file.id });
    },
  }).catch((error: unknown) => error);
  expect(staleComplete).toBeInstanceOf(ApiError);
  expect((staleComplete as ApiError).code).toBe("version_conflict");
  expect((await downloaded(who, file.id)).toString()).toBe("meanwhile");
});
