import { execFileSync } from "node:child_process";
import {
  createWriteStream,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { randomBytes } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import type { StorageNode } from "@omni/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  MIB,
  sha256,
  startStorageStack,
  type Person,
  type StorageStack,
} from "./storage-support.ts";
import { CookieJar } from "./support.ts";

let stack: StorageStack;
beforeAll(async () => {
  stack = await startStorageStack({});
});
afterAll(() => stack?.stop());

const anonymous = new CookieJar();

async function folder(person: Person, place: object, name: string) {
  const made = await stack.api(person.jar, "POST", "/folders", { name, ...place });
  if (made.status !== 201) throw new Error(`folder ${name}: ${made.status}`);
  return made.body.node as StorageNode;
}

function gradientPng(side: number) {
  const row = 1 + side * 3;
  const raw = Buffer.alloc(row * side);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const at = y * row + 1 + x * 3;
      raw[at] = (x * 255) / side;
      raw[at + 1] = (y * 255) / side;
      raw[at + 2] = 128;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 0 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("a 20 MB photo gets a WebP thumbnail under 100 KB, served again without the original, revalidated with 304, and deleted with the file", async () => {
  const org = await stack.company("thumbs");
  const ana = await stack.member(org.id);
  const outsider = await stack.member((await stack.company("elsewhere")).id);
  const bucket = (await stack.bucket()) as Awaited<ReturnType<StorageStack["bucket"]>> & {
    delete(key: string): Promise<void>;
  };
  const png = gradientPng(2580);
  expect(png.length).toBeGreaterThan(19.9e6);
  expect(png.length).toBeLessThanOrEqual(20e6);
  const photo = await stack.upload(ana.jar, { space: "personal" }, "wall.png", png, "image/png");

  const first = await stack.get(ana.jar, `/files/${photo.id}/thumbnail?size=640`);
  expect(first.status).toBe(200);
  expect(first.headers.get("content-type")).toBe("image/webp");
  const thumb = new Uint8Array(await first.arrayBuffer());
  expect(thumb.length).toBeLessThan(100 * 1024);
  expect(Buffer.from(thumb.subarray(8, 12)).toString("latin1")).toBe("WEBP");
  const etag = first.headers.get("etag")!;

  await bucket.delete(`orgs/${org.id}/${photo.id}`);
  expect(await bucket.head(`orgs/${org.id}/${photo.id}`)).toBeNull();
  const again = await stack.get(ana.jar, `/files/${photo.id}/thumbnail?size=640`);
  expect(again.status).toBe(200);
  expect(sha256(new Uint8Array(await again.arrayBuffer()))).toBe(sha256(thumb));
  const pinned = await stack.get(
    ana.jar,
    `/files/${photo.id}/thumbnail?size=640&v=${photo.contentVersion}`,
  );
  expect(pinned.headers.get("cache-control")).toContain("immutable");
  await pinned.body?.cancel();

  const unchanged = await stack.get(ana.jar, `/files/${photo.id}/thumbnail?size=640`, {
    "if-none-match": etag,
  });
  expect(unchanged.status).toBe(304);
  expect(await unchanged.text()).toBe("");
  expect((await stack.get(outsider.jar, `/files/${photo.id}/thumbnail`)).status).toBe(404);

  const notes = await stack.upload(ana.jar, { space: "personal" }, "notes.txt", Buffer.from("hi"));
  const refused = await stack.api(ana.jar, "GET", `/files/${notes.id}/thumbnail`);
  expect(refused).toMatchObject({ status: 415, body: { code: "NO_THUMBNAIL" } });
  const faked = await stack.upload(
    ana.jar,
    { space: "personal" },
    "fake.jpg",
    randomBytes(4096),
    "image/jpeg",
  );
  expect((await stack.api(ana.jar, "GET", `/files/${faked.id}/thumbnail`)).status).toBe(415);
  expect((await stack.api(ana.jar, "GET", `/files/${photo.id}/thumbnail?size=999`)).status).toBe(
    400,
  );

  expect((await stack.api(ana.jar, "DELETE", `/nodes/${photo.id}`)).status).toBe(200);
  expect((await stack.api(ana.jar, "DELETE", `/nodes/${photo.id}?forever=1`)).status).toBe(204);
  expect(await bucket.head(`orgs/${org.id}/${photo.id}.thumbnail-640.webp`)).toBeNull();
});

test("downloads revalidate with 304, resume only while If-Range matches, and only audio and video leave as their own type", async () => {
  const org = await stack.company("conditional");
  const ana = await stack.member(org.id);
  const bytes = randomBytes(3 * MIB);
  const film = await stack.upload(ana.jar, { space: "personal" }, "clip.mp4", bytes, "video/mp4");

  const whole = await stack.download(ana.jar, film.id);
  expect(whole.status).toBe(200);
  expect(whole.headers.get("content-type")).toBe("video/mp4");
  expect(whole.headers.get("content-disposition")).toMatch(/^attachment;/);
  expect(whole.headers.get("x-content-type-options")).toBe("nosniff");
  const etag = whole.headers.get("etag")!;
  const lastModified = whole.headers.get("last-modified")!;
  expect(new Date(lastModified).getTime()).not.toBeNaN();
  await whole.body?.cancel();

  const fresh = await stack.download(ana.jar, film.id, { "if-none-match": etag });
  expect(fresh.status).toBe(304);
  expect(await fresh.text()).toBe("");
  const stale = await stack.download(ana.jar, film.id, { "if-none-match": '"other"' });
  expect(stale.status).toBe(200);
  await stale.body?.cancel();
  const guarded = await stack.download(ana.jar, film.id, { "if-match": '"other"' });
  expect(guarded.status).toBe(412);

  const resumed = await stack.download(ana.jar, film.id, {
    range: "bytes=1000-",
    "if-range": etag,
  });
  expect(resumed.status).toBe(206);
  expect(sha256(new Uint8Array(await resumed.arrayBuffer()))).toBe(sha256(bytes.subarray(1000)));
  const changed = await stack.download(ana.jar, film.id, {
    range: "bytes=1000-",
    "if-range": '"from-an-older-version"',
  });
  expect(changed.status).toBe(200);
  expect(changed.headers.get("content-length")).toBe(String(bytes.length));
  await changed.body?.cancel();

  const page = await stack.upload(
    ana.jar,
    { space: "personal" },
    "page.html",
    Buffer.from("<script>1</script>"),
    "text/html",
  );
  const served = await stack.download(ana.jar, page.id);
  expect(served.headers.get("content-type")).toBe("application/octet-stream");
  await served.body?.cancel();
});

describe("a folder of more than 1 GiB", () => {
  let ana: Person;
  let shoot: StorageNode;
  let files: Record<string, Uint8Array>;
  beforeAll(async () => {
    const org = await stack.company("zip");
    ana = await stack.member(org.id);
    const big = randomBytes(530 * MIB);
    shoot = await folder(ana, { space: "personal" }, "Shoot");
    const raw = await folder(ana, { parentId: shoot.id }, "Raw");
    await folder(ana, { parentId: shoot.id }, "Empty");
    files = {
      "Shoot/Raw/a.mov": big,
      "Shoot/Raw/b.mov": big.subarray(0, 500 * MIB),
      "Shoot/notes.txt": Buffer.from("call ✓ ñ"),
      "Shoot/empty.bin": Buffer.alloc(0),
    };
    await Promise.all([
      stack.upload(ana.jar, { parentId: raw.id }, "a.mov", files["Shoot/Raw/a.mov"]!),
      stack.upload(ana.jar, { parentId: raw.id }, "b.mov", files["Shoot/Raw/b.mov"]!),
      stack.upload(ana.jar, { parentId: shoot.id }, "notes.txt", files["Shoot/notes.txt"]!),
      stack.upload(ana.jar, { parentId: shoot.id }, "empty.bin", files["Shoot/empty.bin"]!),
    ]);
    const gone = await stack.upload(ana.jar, { parentId: shoot.id }, "gone.txt", Buffer.from("x"));
    await stack.api(ana.jar, "DELETE", `/nodes/${gone.id}`);
  });

  test("zips with its exact length and unzips to the same bytes, without what is in Trash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omni-zip-"));
    try {
      const zipped = await stack.get(ana.jar, `/zip?ids=${shoot.id}`);
      expect(zipped.status).toBe(200);
      expect(zipped.headers.get("content-type")).toBe("application/zip");
      expect(zipped.headers.get("content-disposition")).toContain('filename="Shoot.zip"');
      const length = Number(zipped.headers.get("content-length"));
      expect(length).toBeGreaterThan(1024 * MIB);
      const path = join(dir, "Shoot.zip");
      await pipeline(Readable.fromWeb(zipped.body! as WebReadableStream), createWriteStream(path));
      expect(statSync(path).size).toBe(length);

      execFileSync("unzip", ["-q", path, "-d", join(dir, "out")]);
      for (const [name, bytes] of Object.entries(files)) {
        const unzipped = readFileSync(join(dir, "out", name));
        expect({ name, sha: sha256(unzipped) }).toEqual({ name, sha: sha256(bytes) });
      }
      expect(readdirSync(join(dir, "out", "Shoot")).toSorted()).toEqual([
        "Empty",
        "Raw",
        "empty.bin",
        "notes.txt",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("a selection zips under unique names; a link visitor zips the share and nothing outside it; a stranger zips nothing", async () => {
  const org = await stack.company("selection");
  const ana = await stack.member(org.id);
  const outsider = await stack.member((await stack.company("other")).id);
  const kit = await folder(ana, { space: "personal" }, "Kit");
  const old = await folder(ana, { space: "personal" }, "Old");
  const logo = await stack.upload(ana.jar, { parentId: kit.id }, "logo.png", Buffer.from("new"));
  const oldLogo = await stack.upload(ana.jar, { parentId: old.id }, "logo.png", Buffer.from("old"));
  const payroll = await stack.upload(
    ana.jar,
    { space: "personal" },
    "payroll.csv",
    Buffer.from("$"),
  );

  const unzipList = async (response: Response) => {
    expect(response.status).toBe(200);
    const dir = mkdtempSync(join(tmpdir(), "omni-zip-"));
    try {
      const path = join(dir, "a.zip");
      await pipeline(
        Readable.fromWeb(response.body! as WebReadableStream),
        createWriteStream(path),
      );
      execFileSync("unzip", ["-q", path, "-d", join(dir, "out")]);
      const listing = execFileSync("unzip", ["-Z1", path], { encoding: "utf8" });
      return Object.fromEntries(
        listing
          .trim()
          .split("\n")
          .filter((name) => !name.endsWith("/"))
          .map((name) => [name, readFileSync(join(dir, "out", name), "utf8")]),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const picked = await fetch(new URL("/api/storage/zip", stack.worker.url), {
    method: "POST",
    headers: { cookie: ana.jar.header, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams([
      ["ids", logo.id],
      ["ids", oldLogo.id],
    ]),
  });
  expect(picked.headers.get("content-disposition")).toContain('filename="download.zip"');
  expect(await unzipList(picked)).toEqual({ "logo.png": "new", "logo (2).png": "old" });

  const link = await stack.api(ana.jar, "PUT", `/nodes/${kit.id}/sharing/link`, {
    linkAccess: "anyone",
  });
  const shareId = link.body.sharing.shareId as string;
  expect(await unzipList(await stack.get(anonymous, `/shared/${shareId}/zip`))).toEqual({
    "Kit/logo.png": "new",
  });
  const outside = await stack.get(anonymous, `/shared/${shareId}/zip?ids=${payroll.id}`);
  expect(outside.status).toBe(404);
  expect((await stack.get(outsider.jar, `/zip?ids=${kit.id}`)).status).toBe(404);
});
