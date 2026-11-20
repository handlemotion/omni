import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import type { Api } from "@omni/client";
import type { InferResponseType } from "hono/client";
import { api, call } from "./api.ts";
import { keys } from "./query-keys.ts";
import { storageChanged } from "./storage.ts";

export type StorageSignatureRequest = InferResponseType<
  Api["storage"]["files"][":id"]["signatures"]["$get"],
  200
>["requests"][number];
export type StorageSigningItem = InferResponseType<
  Api["storage"]["signing"][":id"]["$get"],
  200
>["item"];

const memberDoor = () => api.storage.files[":id"].signatures;
const signerDoor = () => api.storage.signing[":id"];

/** Every request made on a file, newest first, with its signers and audit trail. */
export const storageSignaturesQuery = (nodeId: string) =>
  queryOptions({
    queryKey: keys.storageSignatures(nodeId),
    queryFn: ({ signal }) =>
      call(memberDoor().$get({ param: { id: nodeId } }, { init: { signal } })),
    refetchInterval: (query) => {
      const requests = query.state.data?.requests ?? [];
      if (requests.some((r) => r.status === "completed" && !r.sealedSha256)) return 2000;
      if (requests.some((r) => r.status === "sent")) return 15_000;
      return false;
    },
  });

/** `mutate({ id, signers })` sends the file: it is locked and each signer gets a mail. */
export const sendForSignatureMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: ({ id, signers }: { id: string; signers: { email: string; name: string }[] }) =>
      call(memberDoor().$post({ param: { id }, json: { signers } })),
    onSuccess: () => storageChanged(client),
  });

/** `mutate({ requestId })` voids a request still out; the file stays locked. */
export const voidSignatureMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: ({ requestId }: { requestId: string; nodeId: string }) =>
      call(api.storage.signatures[":requestId"].void.$post({ param: { requestId } })),
    onSuccess: (_answer, { nodeId }) =>
      client.invalidateQueries({ queryKey: keys.storageSignatures(nodeId) }),
  });

/** A request as the signed-in person asked to sign it sees it. */
export const signingQuery = (requestId: string) =>
  queryOptions({
    queryKey: keys.signing(requestId),
    queryFn: ({ signal }) =>
      call(signerDoor().$get({ param: { id: requestId } }, { init: { signal } })),
    refetchInterval: (query) => {
      const item = query.state.data?.item;
      if (item?.status === "completed" && !item.sealed) return 2000;
      if (item?.status === "sent" && item.me.signedAt) return 15_000;
      return false;
    },
  });

/**
 * Trades the token from a signing mail's link for a cookie on that one request, so the page
 * opens without signing in. Throws `ApiError` 404 for a wrong or expired link.
 */
export const openSigningLink = (requestId: string, token: string) =>
  call(signerDoor().link.$post({ param: { id: requestId }, json: { token } }));

/** The document as it was sent, for the preview and the download. */
export const signingDocumentUrl = (requestId: string) =>
  signerDoor()
    .content.$url({ param: { id: requestId } })
    .toString();

/** The signed copy with its certificate page, once sealed. */
export const signingSealedUrl = (requestId: string) =>
  signerDoor()
    .sealed.$url({ param: { id: requestId } })
    .toString();

/** `mutate({ requestId, signer })` mails a one-time code to `signer`, the address on the page. */
export const signingCodeMutation = () =>
  mutationOptions({
    mutationFn: ({ requestId, signer }: { requestId: string; signer: string }) =>
      call(signerDoor().code.$post({ param: { id: requestId }, query: { signer } })),
  });

/** `mutate({ requestId, signer, code, typedName, consentVersion })` signs as `signer`. */
export const signMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: ({
      requestId,
      signer,
      ...json
    }: {
      requestId: string;
      signer: string;
      code: string;
      typedName: string;
      consentVersion: string;
    }) => call(signerDoor().sign.$post({ param: { id: requestId }, query: { signer }, json })),
    onSuccess: (answer, { requestId }) => client.setQueryData(keys.signing(requestId), answer),
  });
