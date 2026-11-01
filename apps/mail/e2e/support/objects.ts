// The local stack's S3-compatible gateway (`pnpm stack:up`), one bucket per e2e file.
import { randomUUID } from "node:crypto";
import { AwsClient } from "aws4fetch";
import { createS3Store, type S3Options } from "../../src/objects.ts";

export const links = { imageProxyUrl: "/api/image-proxy", attachmentUrl: "/api/attachments" };

export async function createTestBucket() {
  const options: S3Options = {
    endpoint: process.env.S3_ENDPOINT ?? "http://localhost:7070",
    bucket: `omni-e2e-${randomUUID().slice(0, 8)}`,
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "omni-local",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "omni-local-secret",
    region: process.env.S3_REGION ?? "auto",
  };
  const client = new AwsClient({ ...options, service: "s3" });
  const response = await client.fetch(`${options.endpoint}/${options.bucket}`, {
    method: "PUT",
    body: `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${options.region}</LocationConstraint></CreateBucketConfiguration>`,
  });
  if (!response.ok) throw new Error(`create bucket failed: ${response.status}`);
  return { options, objects: createS3Store(options) };
}
