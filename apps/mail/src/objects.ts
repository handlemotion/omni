// Raw mail, sanitized HTML and attachments go to an S3-compatible bucket: R2 in production, any
// S3 API (the local stack's gateway, MinIO, AWS) elsewhere. Keys are content hashes, so writing
// the same object twice is harmless and a re-sync converges.
import { AwsClient } from "aws4fetch";

export interface ObjectStore {
  put(key: string, body: Uint8Array | string, contentType: string): Promise<void>;
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
export function createS3Store(options: S3Options): ObjectStore {
  const client = new AwsClient({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    service: "s3",
    region: options.region,
  });
  const base = `${options.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(options.bucket)}`;
  const url = (key: string) => `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;

  return {
    async put(key, body, contentType) {
      const response = await client.fetch(url(key), {
        method: "PUT",
        body: typeof body === "string" ? body : new Uint8Array(body),
        headers: { "content-type": contentType },
      });
      if (!response.ok) {
        throw new Error(`object put ${key} failed: ${response.status} ${await response.text()}`);
      }
    },
    async get(key) {
      const response = await client.fetch(url(key));
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`object get ${key} failed: ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
