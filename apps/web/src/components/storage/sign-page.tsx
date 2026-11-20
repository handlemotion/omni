import { lazy, Suspense, useState } from "react";
import { IconDownload } from "@/components/icons/central";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox, CheckboxField } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/field";
import { TextField } from "@/components/ui/text-field";
import { useSign, useSigning, useSigningCode } from "@/hooks/use-storage-signing.ts";
import {
  signingDocumentUrl,
  signingSealedUrl,
  type StorageSigningItem,
} from "@/lib/storage-signing.ts";
import { StageLoading } from "./preview/shared.tsx";
import { storageErrorToast } from "./storage-errors.ts";
import { downloadFile } from "@/lib/download.ts";

const PdfPreview = lazy(() => import("./preview/pdf-preview.tsx"));

export function SignPage({ requestId }: { requestId: string }) {
  const signing = useSigning(requestId);
  const answer = signing.data;
  if (!answer) return null;
  const { item, consent } = answer;
  const documentUrl = signingDocumentUrl(requestId);
  return (
    <div className="flex min-h-0 flex-1 max-md:flex-col">
      <div className="flex min-h-0 flex-1 flex-col max-md:min-h-[60svh]">
        <Suspense fallback={<StageLoading label="Loading the document" />}>
          <PdfPreview url={documentUrl} onDownload={() => downloadFile(documentUrl)} />
        </Suspense>
      </div>
      <aside className="flex w-80 shrink-0 flex-col gap-5 overflow-y-auto border-s p-5 max-md:w-full max-md:border-s-0 max-md:border-t">
        <header className="flex flex-col gap-1">
          <h1 className="truncate text-base text-foreground">{item.fileName}</h1>
          <p className="truncate text-sm text-muted-foreground">{item.workspaceName}</p>
        </header>
        <Signers item={item} />
        <Action item={item} consent={consent} requestId={requestId} />
      </aside>
    </div>
  );
}

function Signers({ item }: { item: StorageSigningItem }) {
  return (
    <ul className="flex flex-col gap-2">
      {item.signers.map((signer, index) => (
        <li key={`${index}:${signer.name}`} className="flex min-h-10 items-center gap-2.5">
          <Avatar size="sm" initials={signer.name.slice(0, 1).toUpperCase()} />
          <span className="min-w-0 flex-1 truncate text-sm">{signer.name}</span>
          {signer.signed && <Badge intent="success">Signed</Badge>}
        </li>
      ))}
    </ul>
  );
}

function Action(props: {
  item: StorageSigningItem;
  consent: { version: string; text: string };
  requestId: string;
}) {
  const { item, requestId } = props;
  if (item.status === "voided") return <Badge intent="secondary">Voided</Badge>;
  if (item.sealed) {
    return (
      <Button intent="outline" onPress={() => downloadFile(signingSealedUrl(requestId))}>
        <IconDownload data-slot="icon" />
        Download signed copy
      </Button>
    );
  }
  if (item.me.signedAt) return null;
  return (
    <SignForm
      key={`${requestId}:${item.me.email}`}
      item={item}
      consent={props.consent}
      requestId={requestId}
    />
  );
}

function SignForm(props: {
  item: StorageSigningItem;
  consent: { version: string; text: string };
  requestId: string;
}) {
  const { requestId, consent } = props;
  const signer = props.item.me.email;
  const [name, setName] = useState(props.item.me.name);
  const [agreed, setAgreed] = useState(false);
  const [code, setCode] = useState("");
  const mailCode = useSigningCode();
  const sign = useSign();
  const typedName = name.trim();
  const codeSent = mailCode.isSuccess;
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!typedName || !agreed || code.trim().length !== 6) return;
        sign.mutate(
          { requestId, signer, code: code.trim(), typedName, consentVersion: consent.version },
          { onError: (error) => storageErrorToast(error, "It was not signed") },
        );
      }}
    >
      <TextField value={name} onChange={setName}>
        <Label>Your name</Label>
        <Input autoComplete="name" />
      </TextField>
      <CheckboxField isSelected={agreed} onChange={setAgreed}>
        <Checkbox>{consent.text}</Checkbox>
      </CheckboxField>
      {codeSent && (
        <>
          <TextField value={code} onChange={setCode} autoFocus>
            <Label>Code</Label>
            <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} />
          </TextField>
          <Button
            type="submit"
            isDisabled={!typedName || !agreed || code.trim().length !== 6}
            isPending={sign.isPending}
          >
            Sign
          </Button>
        </>
      )}
      <Button
        intent={codeSent ? "outline" : "primary"}
        isDisabled={!typedName || !agreed}
        isPending={mailCode.isPending}
        onPress={() =>
          mailCode.mutate(
            { requestId, signer },
            {
              onSuccess: () => setCode(""),
              onError: (error) => storageErrorToast(error, "The code was not sent"),
            },
          )
        }
      >
        {codeSent ? "Email me a new code" : "Email me a code"}
      </Button>
    </form>
  );
}
