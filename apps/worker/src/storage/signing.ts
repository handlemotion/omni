import {
  STORAGE_SIGNING_CONSENT,
  storageSendForSignatureBodySchema,
  storageSignBodySchema,
  type StorageSignatureRequest as WireRequest,
  type StorageSignatureRequestResponse,
  type StorageSignatureRequestsResponse,
  type StorageSigningCodeResponse,
  type StorageSigningItem as WireItem,
  type StorageSigningItemResponse,
  type StorageSigningListResponse,
} from "@omni/contracts";
import {
  forUser,
  STORAGE_PDF_MIME,
  type StorageSignatureRequest,
  type StorageSigningItem,
  type StorageSigningOrigin,
} from "@omni/db";
import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { resolveSession, systemMailSender, type AppEnv } from "../context.ts";
import { apiError } from "../errors.ts";
import { checkRateLimit, clientIp, tooManyRequests } from "../rate-limiter.ts";
import { zValidator } from "../validator.ts";
import { announceDrives } from "./announce.ts";
import { sealAfterResponse } from "./seal.ts";
import { download, memberStorage, refused } from "./http.ts";

const iso = (date: Date | null) => date?.toISOString() ?? null;

const wireRequest = (request: StorageSignatureRequest) =>
  ({
    id: request.id,
    nodeId: request.nodeId,
    contentVersion: request.contentVersion,
    documentSha256: request.documentSha256,
    status: request.status,
    createdAt: request.createdAt.toISOString(),
    completedAt: iso(request.completedAt),
    voidedAt: iso(request.voidedAt),
    sealedNodeId: request.sealedNodeId,
    sealedSha256: request.sealedSha256,
    signers: request.signers.map((signer) => ({
      email: signer.email,
      name: signer.name,
      signedAt: iso(signer.signedAt),
      typedName: signer.typedName,
    })),
    events: request.events.map((event) => ({ ...event, createdAt: event.createdAt.toISOString() })),
  }) satisfies WireRequest;

const wireItem = (item: StorageSigningItem) =>
  ({
    ...item,
    createdAt: item.createdAt.toISOString(),
    me: { ...item.me, signedAt: iso(item.me.signedAt) },
  }) satisfies WireItem;

const originOf: (c: Context<AppEnv>, email: string) => StorageSigningOrigin = (c, email) => {
  return { email, ip: clientIp(c.req.raw), userAgent: c.req.header("user-agent") ?? null };
};

async function hashObject(bucket: R2Bucket, key: string) {
  const head = await bucket.get(key, { range: { offset: 0, length: 5 } });
  const isPdf = head !== null && (await head.text()) === "%PDF-";
  const object = await bucket.get(key);
  if (!object) return null;
  const digest = new crypto.DigestStream("SHA-256");
  await object.body.pipeTo(digest);
  const bytes = new Uint8Array(await digest.digest);
  return { isPdf, sha256: [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("") };
}

const SIGNING_FAILURES = {
  not_a_pdf: ["not_a_pdf", "only a PDF is sent for signature"],
  signature_open: ["signature_open", "this file is already out for signature"],
  signature_closed: ["signature_closed", "this request was completed or voided"],
  already_signed: ["already_signed", "you already signed this"],
  invalid_code: ["invalid_code", "that code is wrong or expired: ask for a new one"],
  version_conflict: ["version_conflict", "the file changed after it was sent"],
} as const;

function refusedSigning(
  c: Context<AppEnv>,
  status: keyof typeof SIGNING_FAILURES | "not_found" | "forbidden",
) {
  if (status === "not_found" || status === "forbidden") return refused(c, status);
  const [code, message] = SIGNING_FAILURES[status];
  return apiError(c, code, message);
}

const signingUrl = (c: Context<AppEnv>, requestId: string) =>
  new URL(`/sign/${requestId}`, c.var.config.auth.webAppURL).toString();

function sendMail(c: Context<AppEnv>, message: { to: string; subject: string; text: string }) {
  const { config, log } = c.var;
  return systemMailSender({ email: c.env.EMAIL, config, log })(message);
}

export const storageSigningMember = new Hono<AppEnv>()
  .post(
    "/files/:id/signatures",
    zValidator("json", storageSendForSignatureBodySchema),
    async (c) => {
      const { signers } = c.req.valid("json");
      const { config, member, user } = c.var;
      const files = memberStorage(c);
      const found = await files.file(c.req.param("id"));
      if (found.status !== "ok") return refused(c, found.status);
      if (found.file.mimeType !== STORAGE_PDF_MIME) return refusedSigning(c, "not_a_pdf");
      const wait = await checkRateLimit(c.env, config, "storageShare", member.id, signers.length);
      if (wait) return tooManyRequests(c, wait, "storageShare");

      const hashed = await hashObject(c.env.STORAGE_BUCKET, found.r2Key);
      if (!hashed) return refused(c, "not_found");
      if (!hashed.isPdf) return refusedSigning(c, "not_a_pdf");
      const origin = originOf(c, user.email);
      const sent = await files.sendForSignature(found.file.id, {
        contentVersion: found.file.contentVersion,
        sha256: hashed.sha256,
        signers,
        origin,
      });
      if (sent.status !== "ok") return refusedSigning(c, sent.status);
      announceDrives(c, [sent.node]);

      const { request, node, workspaceName } = sent;
      const appName = config.auth.appName;
      if (!config.SYSTEM_MAIL_FROM) {
        c.var.log.warn("storage.signing_mail_skipped", { reason: "SYSTEM_MAIL_FROM is not set" });
        return c.json(
          { request: wireRequest(request) } satisfies StorageSignatureRequestResponse,
          201,
        );
      }
      try {
        for (const signer of request.signers) {
          await sendMail(c, {
            to: signer.email,
            subject: `${workspaceName} asks you to sign "${node.name}"`,
            text: [
              `${user.email}, of ${workspaceName}, sent you "${node.name}" to sign on ${appName}.`,
              "",
              "Open this link to read and sign it:",
              "",
              signingUrl(c, request.id),
              "",
              `Sign in with ${signer.email} to open it. If you did not expect it, ignore this email.`,
            ].join("\n"),
          });
        }
      } catch (error) {
        await files.voidSignature(request.id, origin);
        throw error;
      }
      return c.json(
        { request: wireRequest(request) } satisfies StorageSignatureRequestResponse,
        201,
      );
    },
  )

  .get("/files/:id/signatures", async (c) => {
    const listed = await memberStorage(c).signatureRequests(c.req.param("id"));
    if (listed.status !== "ok") return refused(c, listed.status);
    return c.json({
      requests: listed.requests.map(wireRequest),
    } satisfies StorageSignatureRequestsResponse);
  })

  .post("/signatures/:requestId/void", async (c) => {
    const voided = await memberStorage(c).voidSignature(
      c.req.param("requestId"),
      originOf(c, c.var.user.email),
    );
    if (voided.status !== "ok") return refusedSigning(c, voided.status);
    return c.json({
      request: wireRequest(voided.request),
    } satisfies StorageSignatureRequestResponse);
  });

const signedIn = createMiddleware<AppEnv>(async (c, next) => {
  const session = await resolveSession(c);
  if (!session) return apiError(c, "unauthorized", "sign in first");
  c.set("user", session.user);
  await next();
});

const signerDoor = (c: Context<AppEnv>) =>
  forUser(c.var.db, c.var.user.id, c.var.user.scopeOrgId).storage;

export const storageSigning = new Hono<AppEnv>()
  .use(signedIn)

  .get("/", async (c) => {
    const items = await signerDoor(c).toSign();
    return c.json({ items: items.map(wireItem) } satisfies StorageSigningListResponse);
  })

  .get("/:id", async (c) => {
    const item = await signerDoor(c).signingRequest(c.req.param("id"));
    if (!item) return refused(c, "not_found");
    return c.json({
      item: wireItem(item),
      consent: STORAGE_SIGNING_CONSENT,
    } satisfies StorageSigningItemResponse);
  })

  .get("/:id/sealed", async (c) => download(c, await signerDoor(c).sealedFile(c.req.param("id"))))

  .get("/:id/content", async (c) => {
    const origin = originOf(c, c.var.user.email);
    return download(c, await signerDoor(c).signingFile(c.req.param("id"), origin));
  })

  .post("/:id/code", async (c) => {
    const { config, user } = c.var;
    if (!config.SYSTEM_MAIL_FROM) {
      return apiError(c, "unprocessable_entity", "this install sends no mail to send a code with");
    }
    const wait = await checkRateLimit(c.env, config, "storageShare", `signing:${user.id}`);
    if (wait) return tooManyRequests(c, wait, "storageShare");
    const started = await signerDoor(c).startSigningCode(
      c.req.param("id"),
      originOf(c, user.email),
    );
    if (started.status !== "ok") return refusedSigning(c, started.status);
    await sendMail(c, {
      to: started.email,
      subject: `Your code to sign "${started.fileName}"`,
      text: [
        `Your code to sign "${started.fileName}" for ${started.workspaceName} is:`,
        "",
        started.code,
        "",
        "It works for 10 minutes. If you did not ask to sign anything, ignore this email.",
      ].join("\n"),
    });
    return c.json({
      expiresAt: started.expiresAt.toISOString(),
    } satisfies StorageSigningCodeResponse);
  })

  .post("/:id/sign", zValidator("json", storageSignBodySchema), async (c) => {
    const { code, typedName, consentVersion } = c.req.valid("json");
    if (consentVersion !== STORAGE_SIGNING_CONSENT.version) {
      return apiError(c, "consent_changed", "the consent sentence changed: read it again");
    }
    const signed = await signerDoor(c).sign(c.req.param("id"), {
      code,
      typedName,
      consentVersion,
      origin: originOf(c, c.var.user.email),
    });
    if (signed.status !== "ok") return refusedSigning(c, signed.status);
    if (signed.completed) {
      sealAfterResponse(c, signed.item.id, (node) => announceDrives(c, [node]));
    }
    return c.json({
      item: wireItem(signed.item),
      consent: STORAGE_SIGNING_CONSENT,
    } satisfies StorageSigningItemResponse);
  });
