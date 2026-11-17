// Signing (ADR 0043 decision 6): a file's signature requests as its sender sees them, sending and
// voiding, and the signer's side under `/api/storage/signing` (the request, its document, the
// mailed code, the signature and the sealed copy).
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
    // Signers sign elsewhere and no realtime event says so: ask again while one is still to
    // come (every 15 s), then until the signed copy is there (every 2 s).
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
    // The lock changes the file's row in its folder too.
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
    // The page has no realtime connection, so it asks again while something is still to come:
    // others signing after this person did (every 15 s), then the sealed copy (every 2 s).
    refetchInterval: (query) => {
      const item = query.state.data?.item;
      if (item?.status === "completed" && !item.sealed) return 2000;
      if (item?.status === "sent" && item.me.signedAt) return 15_000;
      return false;
    },
  });

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

/** `mutate({ requestId })` mails a one-time code to the address the person signs as. */
export const signingCodeMutation = () =>
  mutationOptions({
    mutationFn: ({ requestId }: { requestId: string }) =>
      call(signerDoor().code.$post({ param: { id: requestId } })),
  });

/** `mutate({ requestId, code, typedName, consentVersion })` signs. */
export const signMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: ({
      requestId,
      ...json
    }: {
      requestId: string;
      code: string;
      typedName: string;
      consentVersion: string;
    }) => call(signerDoor().sign.$post({ param: { id: requestId }, json })),
    onSuccess: (answer, { requestId }) => client.setQueryData(keys.signing(requestId), answer),
  });
