import { AwsClient } from "aws4fetch";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

export interface ObjectStore {
  put(key: string, body: Uint8Array | string, contentType: string): Promise<void>;
  /** `put` streamed from a file, for objects too big to hold in memory. */
  putFile(key: string, file: { path: string; size: number }, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
}

export interface S3Options {
  /** e.g. `https://<account>.r2.cloudflarestorage.com` or `http://localhost:7070`. */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** R2 takes `auto`. */
  region: string;
}

/** Path-style S3 client over fetch. */
export const createS3Store: (options: S3Options) => ObjectStore = (options) => {
  const client = new AwsClient({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    service: "s3",
    region: options.region,
  });
  const base = `${options.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(options.bucket)}`;
  const url = (key: string) => `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;

  const checked = async (key: string, response: Response) => {
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200);
      throw new Error(`object put ${key} failed: ${response.status} ${detail}`);
    }
  };

  return {
    async put(key, body, contentType) {
      const response = await client.fetch(url(key), {
        method: "PUT",
        body: typeof body === "string" ? body : new Uint8Array(body),
        headers: { "content-type": contentType },
      });
      await checked(key, response);
    },
    async putFile(key, file, contentType) {
      const response = await client.fetch(url(key), {
        method: "PUT",
        body: Readable.toWeb(createReadStream(file.path)) as ReadableStream<Uint8Array>,
        headers: {
          "content-type": contentType,
          "content-length": String(file.size),
          "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
        },
        duplex: "half",
      } as RequestInit);
      await checked(key, response);
    },
    async get(key) {
      const response = await client.fetch(url(key));
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`object get ${key} failed: ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
};
