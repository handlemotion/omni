/**
 * How to unsubscribe from a list message, from its List-Unsubscribe URIs (RFC 2369) and whether
 * it offers one-click (RFC 8058). Best first:
 *
 * - `post`: one-click. A server POSTs `List-Unsubscribe=One-Click` to the https URI; done.
 * - `mail`: a message to the mailto URI, with the subject and body it names.
 * - `link`: a web page the reader finishes the unsubscribe on.
 */
export type Unsubscribe =
  | { kind: "post"; url: string }
  | { kind: "mail"; to: string; subject: string; body: string }
  | { kind: "link"; url: string };

export const unsubscribeMethod: (
  uris: readonly string[],
  oneClick: boolean,
) => Unsubscribe | null = (uris, oneClick) => {
  const https = uris.map((uri) => webUrl(uri, ["https:"])).find((url) => url !== null);
  // RFC 8058: one-click is only an https URI.
  if (oneClick && https) return { kind: "post", url: https };
  for (const uri of uris) {
    const mail = mailto(uri);
    if (mail) return mail;
  }
  const page = uris.map((uri) => webUrl(uri, ["https:", "http:"])).find((url) => url !== null);
  return page ? { kind: "link", url: page } : null;
};

function webUrl(uri: string, protocols: string[]) {
  const url = parse(uri);
  return url && protocols.includes(url.protocol) ? url.href : null;
}

const mailto: (uri: string) => Unsubscribe | null = (uri) => {
  const url = parse(uri);
  if (url?.protocol !== "mailto:") return null;
  // `mailto:a@x,b@x`: the first address does.
  const to = decode(url.pathname.split(",")[0] ?? "");
  if (!/^[^\s@]+@[^\s@]+$/.test(to)) return null;
  // URLSearchParams reads `+` as a space, which mailto does not; keep it.
  const params = new URLSearchParams(url.search.replaceAll("+", "%2B"));
  return {
    kind: "mail",
    to,
    subject: params.get("subject")?.trim() || "Unsubscribe",
    body: params.get("body") ?? "",
  };
};

const parse: (uri: string) => URL | null = (uri) => {
  try {
    return new URL(uri.trim());
  } catch {
    return null;
  }
};

function decode(value: string) {
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return value.trim();
  }
}
