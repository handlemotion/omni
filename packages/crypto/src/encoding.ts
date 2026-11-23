const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

type Digestible = Parameters<typeof crypto.subtle.digest>[1];

export function utf8(text: string) {
  return encoder.encode(text) as Uint8Array<ArrayBuffer> satisfies Uint8Array<ArrayBuffer>;
}

export function fromUtf8(bytes: Uint8Array) {
  return decoder.decode(bytes);
}

export function toHex(bytes: Uint8Array) {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** SHA-256 of the bytes, or of a string's UTF-8 bytes. */
export async function sha256(data: string | Digestible) {
  const bytes = typeof data === "string" ? utf8(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/** SHA-256 as lowercase hex. */
export async function sha256Hex(data: string | Digestible) {
  return toHex(await sha256(data));
}

export const fromHex: (hex: string) => Uint8Array<ArrayBuffer> | null = (hex) => {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/** Standard, padded base64. */
export function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** URL-safe base64 without padding. */
export function toBase64Url(bytes: Uint8Array) {
  return toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** `bytes` random bytes from the CSPRNG, as unpadded base64url. */
export function randomToken(bytes: number) {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Accepts standard or URL-safe base64, padded or not. Returns null on malformed input. */
export const fromBase64: (text: string) => Uint8Array<ArrayBuffer> | null = (text) => {
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(text)) return null;
  const standard = text.replaceAll("-", "+").replaceAll("_", "/");
  try {
    const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
};
