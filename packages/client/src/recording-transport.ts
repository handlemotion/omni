import {
  ERROR_FORMAT_HEADER,
  ERROR_FORMAT_VERSION,
  toApiError,
  type ApiErrorInfo,
} from "@omni/contracts/errors";

export interface RecordingTransport {
  /** The Worker's origin. */
  baseUrl: string;
  fetch?: typeof fetch;
  /** Headers for every request (iOS: the session cookie). */
  headers?: Record<string, string>;
}

/** A failed call while finishing a recording; the spool is kept, so finishing again resumes. */
export class RecordingUploadError extends Error {
  readonly status: number;
  readonly info: ApiErrorInfo;

  constructor(status: number, info: ApiErrorInfo) {
    super(info.message);
    this.name = "RecordingUploadError";
    this.status = status;
    this.info = info;
  }
}

export type Answer = { status: number; ok: boolean; json: unknown };

export async function send(
  transport: RecordingTransport,
  method: string,
  path: string,
  init: { body?: BodyInit; headers?: Record<string, string> } = {},
) {
  const response = await (transport.fetch ?? fetch)(new URL(`/api${path}`, transport.baseUrl), {
    method,
    credentials: "include",
    headers: { [ERROR_FORMAT_HEADER]: ERROR_FORMAT_VERSION, ...init.headers, ...transport.headers },
    body: init.body,
  });
  const text = await response.text();
  const json: unknown = text ? JSON.parse(text) : null;
  return { status: response.status, ok: response.ok, json } satisfies Answer;
}

export const failure = (answer: Pick<Answer, "status" | "json">, what: string) =>
  new RecordingUploadError(
    answer.status,
    toApiError(answer.json, `${what} failed (${answer.status})`),
  );
