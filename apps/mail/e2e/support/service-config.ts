import type { S3Options } from "../../src/objects.ts";
import { loadConfig } from "../../src/config.ts";

/**
 * The mail service's config as production parses it, so its defaults are the real ones. Syncs and
 * outbox polls run hourly: a test drives them through pings and reconciles.
 */
export function testServiceConfig(
  base: {
    databaseUrl: string;
    credentialsKey: string;
    hmacSecret: string;
    workerUrl: string;
    bucket: S3Options;
  },
  env: NodeJS.ProcessEnv = {},
) {
  return loadConfig({
    DATABASE_URL: base.databaseUrl,
    MAIL_CREDENTIALS_KEY: base.credentialsKey,
    MAIL_SERVICE_HMAC_SECRET: base.hmacSecret,
    WORKER_URL: base.workerUrl,
    S3_ENDPOINT: base.bucket.endpoint,
    S3_BUCKET: base.bucket.bucket,
    S3_ACCESS_KEY_ID: base.bucket.accessKeyId,
    S3_SECRET_ACCESS_KEY: base.bucket.secretAccessKey,
    S3_REGION: base.bucket.region,
    SYNC_INTERVAL_MS: String(60 * 60_000),
    OUTBOX_INTERVAL_MS: String(60 * 60_000),
    ...env,
  });
}
