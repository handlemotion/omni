import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { apiError } from "./errors.ts";
import { zValidator } from "./validator.ts";

const MAX_PICTURE_BYTES = 2 * 1024 * 1024;

function sniffImageType(bytes: Uint8Array) {
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39)) {
    return bytes[5] === 0x61 ? "image/gif" : null;
  }
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

/** The multipart body of a picture upload: one `file`, at most `MAX_PICTURE_BYTES`. */
export const pictureUpload = [
  bodyLimit({
    maxSize: MAX_PICTURE_BYTES + 64 * 1024,
    onError: (c) => apiError(c, "payload_too_large", "the picture is larger than 2 MB"),
  }),
  zValidator(
    "form",
    z.object({ file: z.instanceof(File) }),
    "send the picture as the form field `file`",
  ),
] as const;

/** The uploaded picture's bytes and sniffed type. Throws 413 when too large, 415 when not an image. */
export async function readPicture(file: File) {
  if (file.size > MAX_PICTURE_BYTES) {
    throw new HTTPException(413, { message: "the picture is larger than 2 MB" });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentType = sniffImageType(bytes);
  if (!contentType) {
    throw new HTTPException(415, { message: "the picture must be a PNG, JPEG, WebP or GIF" });
  }
  return { bytes, contentType };
}
