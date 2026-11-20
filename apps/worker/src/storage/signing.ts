import {
  STORAGE_SIGNING_CONSENT,
  storageSendForSignatureBodySchema,
  storageSignBodySchema,
  storageSigningLinkBodySchema,
  storageSignerQuerySchema,
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
  issueSigningLinks,
  linkSigner,
  STORAGE_PDF_MIME,
  STORAGE_SIGNING_LINK_TTL_MS,
  type StorageSignatureRequest,
  type StorageSigningItem,
  type StorageSigningOrigin,
} from "@omni/db";
import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
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

const signingUrl = (c: Context<AppEnv>, requestId: string, token: string) =>
  new URL(`/sign/${requestId}#t=${token}`, c.var.config.auth.webAppURL).toString();

function sendMail(c: Context<AppEnv>, message: { to: string; subject: string; text: string }) {
  const { config, log } = c.var;
  return systemMailSender({ email: c.env.EMAIL, config, log })(message);
}

type SendOutcome =
  | { ok: true; request: StorageSignatureRequest }
  | { ok: false; response: Response };

/**
 * Sends one Shared PDF for signature as the member: hashes it, locks it, records the request and
 * mails each signer their link. A failed mail voids the request again. CRM contracts go out
 * through this too, so a contract's signers get the same mail and the same signing page.
 */
export async function sendFileForSignature(
  c: Context<AppEnv>,
  fileId: string,
  signers: { email: string; name: string }[],
) {
  const { config, member, user } = c.var;
  const files = memberStorage(c);
  const fail = (response: Response) => ({ ok: false, response }) satisfies SendOutcome;
  const found = await files.file(fileId);
  if (found.status !== "ok") return fail(refused(c, found.status));
  if (found.file.mimeType !== STORAGE_PDF_MIME) return fail(refusedSigning(c, "not_a_pdf"));
  const wait = await checkRateLimit(c.env, config, "storageShare", member.id, signers.length);
  if (wait) return fail(tooManyRequests(c, wait, "storageShare"));

  const hashed = await hashObject(c.env.STORAGE_BUCKET, found.r2Key);
  if (!hashed) return fail(refused(c, "not_found"));
  if (!hashed.isPdf) return fail(refusedSigning(c, "not_a_pdf"));
  const origin = originOf(c, user.email);
  const sent = await files.sendForSignature(found.file.id, {
    contentVersion: found.file.contentVersion,
    sha256: hashed.sha256,
    signers,
    origin,
  });
  if (sent.status !== "ok") return fail(refusedSigning(c, sent.status));
  announceDrives(c, [sent.node]);

  const { request, node, workspaceName } = sent;
  const appName = config.auth.appName;
  if (!config.SYSTEM_MAIL_FROM) {
    c.var.log.warn("storage.signing_mail_skipped", { reason: "SYSTEM_MAIL_FROM is not set" });
    return { ok: true, request } satisfies SendOutcome;
  }
  try {
    const links = await issueSigningLinks(c.var.db, request.id);
    for (const signer of links) {
      await sendMail(c, {
        to: signer.email,
        subject: `${workspaceName} asks you to sign "${node.name}"`,
        text: [
          `${user.email}, of ${workspaceName}, sent you "${node.name}" to sign on ${appName}.`,
          "",
          "Open this link to read and sign it:",
          "",
          signingUrl(c, request.id, signer.token),
          "",
          "The link is yours alone: it opens this document as you. If you did not expect it, ignore this email.",
        ].join("\n"),
      });
    }
  } catch (error) {
    await files.voidSignature(request.id, origin);
    throw error;
  }
  return { ok: true, request } satisfies SendOutcome;
}

/** Voids an open request as the member, for the audit trail. */
export const voidSignatureRequest = (c: Context<AppEnv>, requestId: string) =>
  memberStorage(c).voidSignature(requestId, originOf(c, c.var.user.email));

export const storageSigningMember = new Hono<AppEnv>()
  .post(
    "/files/:id/signatures",
    zValidator("json", storageSendForSignatureBodySchema),
    async (c) => {
      const sent = await sendFileForSignature(c, c.req.param("id"), c.req.valid("json").signers);
      if (!sent.ok) return sent.response;
      return c.json(
        { request: wireRequest(sent.request) } satisfies StorageSignatureRequestResponse,
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

const SIGNING_COOKIE = "omni_signing";
const signingCookiePath = (requestId: string) =>
  `/api/storage/signing/${encodeURIComponent(requestId)}`;

type SignerDoor = NonNullable<Awaited<ReturnType<typeof linkSigner>>>;
type Signer = NonNullable<Awaited<ReturnType<typeof signerOf>>>;

async function signerOf(c: Context<AppEnv>, requestId: string) {
  const token = getCookie(c, SIGNING_COOKIE);
  const linked = token ? await linkSigner(c.var.db, requestId, token) : null;
  if (linked) return { door: linked satisfies SignerDoor, actor: `link:${requestId}`, email: "" };
  const session = await resolveSession(c);
  if (!session) return null;
  const { user } = session;
  const door: SignerDoor = forUser(c.var.db, user.id, user.scopeOrgId).storage;
  return { door, actor: user.id, email: user.email };
}

async function showsOtherSigner(signer: Signer, requestId: string, shown: string | undefined) {
  if (!shown) return false;
  const item = await signer.door.signingRequest(requestId);
  return !!item && item.me.email.toLowerCase() !== shown.trim().toLowerCase();
}

export const storageSigning = new Hono<AppEnv>()
  .get("/", signedIn, async (c) => {
    const items = await forUser(c.var.db, c.var.user.id, c.var.user.scopeOrgId).storage.toSign();
    return c.json({ items: items.map(wireItem) } satisfies StorageSigningListResponse);
  })

  .post("/:id/link", zValidator("json", storageSigningLinkBodySchema), async (c) => {
    const requestId = c.req.param("id");
    const { token } = c.req.valid("json");
    if (!(await linkSigner(c.var.db, requestId, token))) return refused(c, "not_found");
    setCookie(c, SIGNING_COOKIE, token, {
      path: signingCookiePath(requestId),
      httpOnly: true,
      secure: new URL(c.req.url).protocol === "https:",
      sameSite: "Lax",
      expires: new Date(Date.now() + STORAGE_SIGNING_LINK_TTL_MS),
    });
    return c.body(null, 204);
  })

  .get("/:id", async (c) => {
    const signer = await signerOf(c, c.req.param("id"));
    if (!signer) return apiError(c, "unauthorized", "sign in first");
    const item = await signer.door.signingRequest(c.req.param("id"));
    if (!item) return refused(c, "not_found");
    return c.json({
      item: wireItem(item),
      consent: STORAGE_SIGNING_CONSENT,
    } satisfies StorageSigningItemResponse);
  })

  .get("/:id/sealed", async (c) => {
    const signer = await signerOf(c, c.req.param("id"));
    if (!signer) return apiError(c, "unauthorized", "sign in first");
    return download(c, await signer.door.sealedFile(c.req.param("id")));
  })

  .get("/:id/content", async (c) => {
    const signer = await signerOf(c, c.req.param("id"));
    if (!signer) return apiError(c, "unauthorized", "sign in first");
    const origin = originOf(c, signer.email);
    return download(c, await signer.door.signingFile(c.req.param("id"), origin));
  })

  .post("/:id/code", zValidator("query", storageSignerQuerySchema), async (c) => {
    const { config } = c.var;
    const signer = await signerOf(c, c.req.param("id"));
    if (!signer) return apiError(c, "unauthorized", "sign in first");
    if (await showsOtherSigner(signer, c.req.param("id"), c.req.valid("query").signer)) {
      return apiError(c, "signer_changed", "this page is open as another signer: reload it");
    }
    if (!config.SYSTEM_MAIL_FROM) {
      return apiError(c, "unprocessable_entity", "this install sends no mail to send a code with");
    }
    const wait = await checkRateLimit(c.env, config, "storageShare", `signing:${signer.actor}`);
    if (wait) return tooManyRequests(c, wait, "storageShare");
    const started = await signer.door.startSigningCode(
      c.req.param("id"),
      originOf(c, signer.email),
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

  .post(
    "/:id/sign",
    zValidator("query", storageSignerQuerySchema),
    zValidator("json", storageSignBodySchema),
    async (c) => {
      const signer = await signerOf(c, c.req.param("id"));
      if (!signer) return apiError(c, "unauthorized", "sign in first");
      if (await showsOtherSigner(signer, c.req.param("id"), c.req.valid("query").signer)) {
        return apiError(c, "signer_changed", "this page is open as another signer: reload it");
      }
      const { code, typedName, consentVersion } = c.req.valid("json");
      if (consentVersion !== STORAGE_SIGNING_CONSENT.version) {
        return apiError(c, "consent_changed", "the consent sentence changed: read it again");
      }
      const signed = await signer.door.sign(c.req.param("id"), {
        code,
        typedName,
        consentVersion,
        origin: originOf(c, signer.email),
      });
      if (signed.status !== "ok") return refusedSigning(c, signed.status);
      if (signed.completed) {
        sealAfterResponse(c, signed.item.id, (node) => announceDrives(c, [node]));
      }
      return c.json({
        item: wireItem(signed.item),
        consent: STORAGE_SIGNING_CONSENT,
      } satisfies StorageSigningItemResponse);
    },
  );
