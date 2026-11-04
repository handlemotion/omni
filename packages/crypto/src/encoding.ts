// Byte helpers on globals that exist in both Workers and Node (TextEncoder, btoa, atob).

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  // Always a fresh ArrayBuffer; workers-types widens the return type to ArrayBufferLike.
  return encoder.encode(text) as Uint8Array<ArrayBuffer>;
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** SHA-256 of the text's UTF-8 bytes, as lowercase hex. */
export async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(text))));
}

export function fromHex(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Accepts standard or URL-safe base64, padded or not. Returns null on malformed input. */
export function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
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
}
