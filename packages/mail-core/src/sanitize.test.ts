// The sanitizer against known XSS and remote-load vectors: OWASP's filter evasion cheat sheet,
// cure53's DOMPurify mXSS cases, and mail-specific tracking tricks. Each vector is checked by
// an oracle that re-parses the output the way the client's iframe will and fails on anything
// that executes or fetches from somewhere other than our proxy or attachment store.
import { describe, expect, test } from "vitest";
import { sanitizeHtml } from "./html.ts";
import { attribute, elements, parseBodyFragment, textContent } from "./tree.ts";

const PROXY = "https://img.omni.test/p?u=";
const ATTACHMENTS = "https://omni.test/attachments/";
const options = {
  proxyUrl: (src: string) => PROXY + encodeURIComponent(src),
  cidUrl: (id: string) => ATTACHMENTS + encodeURIComponent(id),
};

const EXECUTES_OR_EMBEDS = new Set([
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "form",
  "input",
  "button",
  "base",
  "meta",
  "link",
  "svg",
  "math",
  "template",
  "noscript",
  "audio",
  "video",
  "source",
  "portal",
]);
const URL_ATTRIBUTES = ["href", "src", "action", "formaction", "xlink:href", "data", "cite"];
const FETCHING_ATTRIBUTES = ["srcset", "background", "poster", "ping", "lowsrc", "dynsrc"];

/** Browsers strip these from URLs before reading the scheme. */
const scheme = (url: string) =>
  [...url]
    .filter((char) => char > " " && char !== "\u007f")
    .join("")
    .toLowerCase()
    .match(/^([a-z][a-z0-9+.-]*):/)?.[1] ?? null;

const loadsFromUs = (url: string) =>
  url.startsWith(PROXY) || url.startsWith(ATTACHMENTS) || /^data:image\//i.test(url);

/** Every problem a browser would act on in `html`; empty means inert. */
function hazards(html: string): string[] {
  const found: string[] = [];
  const checkCss = (css: string, where: string) => {
    if (/@import|expression\s*\(|\\|image-set|\bimage\s*\(|\bsrc\s*\(/i.test(css)) {
      found.push(`${where}: unsafe CSS ${css.slice(0, 80)}`);
    }
    const urls = [...css.matchAll(/url\(\s*["']?([^"')]*)/gi)].map((m) => m[1] ?? "");
    // A url( without its ")" still loads: the browser closes it at the end.
    if ((css.match(/url\(/gi) ?? []).length !== urls.length || /url\([^)]*$/i.test(css)) {
      found.push(`${where}: unterminated url(`);
    }
    for (const url of urls) if (!loadsFromUs(url)) found.push(`${where}: css url ${url}`);
  };

  for (const element of elements(parseBodyFragment(html))) {
    const tag = element.tagName;
    if (EXECUTES_OR_EMBEDS.has(tag)) found.push(`<${tag}>`);
    if (tag === "style") checkCss(textContent(element), "<style>");
    for (const { name, value } of element.attrs) {
      if (name.startsWith("on")) found.push(`${tag}[${name}]`);
      if (FETCHING_ATTRIBUTES.includes(name)) found.push(`${tag}[${name}]`);
      if (name === "style") checkCss(value, `${tag}[style]`);
      if (URL_ATTRIBUTES.includes(name)) {
        const s = scheme(value);
        if (s !== null && !["http", "https", "mailto", "tel", "cid"].includes(s)) {
          if (!(tag === "img" && /^data:image\//i.test(value.trim()))) {
            found.push(`${tag}[${name}=${value.slice(0, 40)}]`);
          }
        }
        if (name === "src" && !loadsFromUs(value)) found.push(`${tag}[src=${value}]`);
      }
    }
    if ((tag === "a" || tag === "area") && attribute(element, "href") !== null) {
      if (attribute(element, "target") !== "_blank") found.push(`${tag} opens in the frame`);
      if (!/\bnoopener\b/.test(attribute(element, "rel") ?? "")) found.push(`${tag} no noopener`);
      if (!/\bnoreferrer\b/.test(attribute(element, "rel") ?? ""))
        found.push(`${tag} no noreferrer`);
    }
  }
  return found;
}

const T = "https://t.example.com";

// [name, html]. Every vector here is inert after sanitizing, in both image modes.
const VECTORS: [string, string][] = [
  ["script tag", "<script>alert(1)</script>"],
  ["img onerror", "<img src=x onerror=alert(1)>"],
  ["javascript: img src", `<IMG SRC="javascript:alert('XSS');">`],
  ["mixed-case scheme", "<IMG SRC=JaVaScRiPt:alert('XSS')>"],
  ["tab inside scheme", `<a href="jav&#x09;ascript:alert(1)">x</a>`],
  ["newline inside scheme", `<a href="jav&#x0A;ascript:alert(1)">x</a>`],
  ["leading control chars", `<a href=" &#14; javascript:alert(1)">x</a>`],
  [
    "decimal entities",
    `<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">x</a>`,
  ],
  [
    "hex entities without semicolons",
    `<a href="&#x6A&#x61&#x76&#x61&#x73&#x63&#x72&#x69&#x70&#x74&#x3A;alert(1)">x</a>`,
  ],
  ["named colon entity", `<a href="javascript&colon;alert(1)">x</a>`],
  ["NUL inside scheme", `<a href="java\u0000script:alert(1)">x</a>`],
  ["vbscript:", `<a href="vbscript:msgbox(1)">x</a>`],
  [
    "data:text/html link",
    `<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>`,
  ],
  ["area javascript:", `<map name="m"><area href="javascript:alert(1)" shape="rect"></map>`],
  ["svg script", "<svg><script>alert(1)</script></svg>"],
  ["svg onload", "<svg onload=alert(1)>"],
  ["svg xlink", `<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>`],
  ["svg image", `<svg><image href="${T}/svg.gif"></image></svg>`],
  ["math href", `<math href="javascript:alert(1)">x</math>`],
  [
    "mXSS: mglyph/style namespace confusion",
    "<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>",
  ],
  ["mXSS: svg </p> style", `<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">`],
  [
    "mXSS: nested form",
    "<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>",
  ],
  ["mXSS: noscript title", `<noscript><p title="</noscript><img src=x onerror=alert(1)>">`],
  ["comment breakout", `<!--<img src="--><img src=x onerror=alert(1)//">`],
  ["style comment breakout", "<style>/*</style><img src=x onerror=alert(1)>*/</style>"],
  ["xmp raw text", "<xmp><img src=x onerror=alert(1)></xmp>"],
  ["template", "<template><img src=x onerror=alert(1)></template>"],
  ["iframe srcdoc", `<iframe srcdoc="<script>alert(1)</script>"></iframe>`],
  ["object and embed", `<object data="${T}/o.swf"></object><embed src="${T}/e.swf">`],
  ["base href", `<base href="${T}/">`],
  ["meta refresh", `<meta http-equiv="refresh" content="0;url=${T}/r">`],
  [
    "form, formaction, image input",
    `<form action="${T}/f"><button formaction="${T}/b">x</button><input type="image" src="${T}/i.gif"></form>`,
  ],
  ["link stylesheet", `<link rel="stylesheet" href="${T}/s.css">`],
  ["body background and onload", `<body background="${T}/body.gif" onload="alert(1)">x</body>`],
  ["table background", `<table background="${T}/t.gif"><tr><td>x</td></tr></table>`],
  ["srcset", `<img srcset="${T}/a.gif 1x, ${T}/b.gif 2x">`],
  ["picture source", `<picture><source srcset="${T}/p.gif"><img src="${T}/p2.gif"></picture>`],
  ["video poster", `<video poster="${T}/p.gif"></video>`],
  ["a ping", `<a ping="${T}/ping" href="https://example.com/">x</a>`],
  ["protocol-relative img", `<img src="//t.example.com/pr.gif">`],
  ["backslash host img", `<img src="https:\\\\t.example.com\\bs.gif">`],
  ["relative img", `<img src="/pixel.gif">`],
  ["sender-filled blocked src", `<img data-omni-src="${T}/sneak.gif">`],
  [
    "sender-filled internal style attribute",
    `<p data-omni-style="background:url(${T}/ds.gif)">x</p>`,
  ],
  ["@import string", `<style>@import '${T}/i.css';</style>`],
  ["@import url, no semicolon", `<style>@import url(${T}/i.css)</style>`],
  ["@import after a rule", `<style>p{color:red}@import url(${T}/i.css);</style>`],
  ["unterminated url() in style attribute", `<p style="background:url(${T}/u.gif">x</p>`],
  ["unterminated url() in <style>", `<style>p{background:url(${T}/u.gif</style>`],
  ["uppercase URL()", `<p style="background:URL(${T}/U.gif)">x</p>`],
  ["protocol-relative CSS url", `<p style="background:url(//t.example.com/pr.gif)">x</p>`],
  ["CSS escape", `<p style="background:u\\72l(${T}/e.gif)">x</p>`],
  ["CSS escape inside url", `<p style="background:url(${T}/\\65.gif)">x</p>`],
  ["image-set", `<p style="background-image:image-set('${T}/is.gif' 1x)">x</p>`],
  ["-webkit-image-set", `<p style="background-image:-webkit-image-set('${T}/is.gif' 1x)">x</p>`],
  ["cross-fade", `<p style="background:cross-fade(url(${T}/a.gif), url(${T}/b.gif), 50%)">x</p>`],
  ["expression()", `<p style="width:expression(alert(1))">x</p>`],
  [
    "behavior and -moz-binding",
    `<p style="behavior:url(${T}/x.htc);-moz-binding:url(${T}/x.xml#x)">x</p>`,
  ],
  ["@font-face", `<style>@font-face{font-family:x;src:url(${T}/f.woff)}</style>`],
  [":visited exfiltration", `<style>a:visited{background:url(${T}/v.gif)}</style>`],
  [
    "attribute-selector exfiltration",
    `<style>a[href^="https://bank"]{background:url(${T}/a.gif)}</style>`,
  ],
  ["@namespace", `<style>@namespace url(${T}/ns);</style>`],
  ["multiple url()s", `<p style="background:url(${T}/a.gif), url( '${T}/b.gif' )">x</p>`],
  [
    "quote smuggling inside url()",
    `<p style="background:url('data:image/png,x\\'); background:url(${T}/q.gif)')">x</p>`,
  ],
  [
    "paren smuggling inside url()",
    `<p style="background:url(data:image/png,x(url(${T}/p.gif)))">x</p>`,
  ],
  ["svg style @import", `<svg><style>@import url(${T}/svg.css)</style></svg>`],
  ["target _top", `<a href="https://example.com/" target="_top">x</a>`],
  ["area target", `<map name="m"><area href="https://example.com/" target="_parent"></map>`],
];

describe.each(["block", "proxy"] as const)("remote images: %s", (remoteImages) => {
  test.each(VECTORS)("%s", (_name, vector) => {
    const { html } = sanitizeHtml(vector, { ...options, remoteImages });
    expect(hazards(html)).toEqual([]);
  });
});

test("the oracle catches each hazard class it is meant to", () => {
  // Guards the guard: if the oracle went blind, every vector above would pass vacuously.
  expect(hazards(`<img src="${T}/a.gif">`)).not.toEqual([]);
  expect(hazards(`<p style="background:url(${T}/a.gif)">x</p>`)).not.toEqual([]);
  expect(hazards(`<p style="background:url(${T}/a.gif">x</p>`)).not.toEqual([]);
  expect(hazards(`<a href="java&#x09;script:x">x</a>`)).not.toEqual([]);
  expect(hazards(`<a href="https://example.com/">x</a>`)).not.toEqual([]);
  expect(hazards("<style>@import 'x';</style>")).not.toEqual([]);
  expect(hazards("<b onclick=x>x</b>")).not.toEqual([]);
});

const links = (html: string) => sanitizeHtml(html, options).linkMismatches;

test("inline styles survive, with their URLs rewritten", () => {
  const html = `<p style="color: red; font-family: 'A B'; background: url(https://cdn.example.com/a.png)">x</p>`;
  expect(sanitizeHtml(html, options).html).toBe(
    `<p style="color: red; font-family: 'A B'; background: none">x</p>`,
  );
  expect(sanitizeHtml(html, { ...options, remoteImages: "proxy" }).html).toBe(
    `<p style="color: red; font-family: 'A B'; background: url(&quot;${PROXY}${encodeURIComponent("https://cdn.example.com/a.png")}&quot;)">x</p>`,
  );
  // Inline styles travel through DOMPurify under this name; a sender cannot use it.
  expect(sanitizeHtml(`<p data-omni-style="color: blue">y</p>`, options).html).toBe("<p>y</p>");
});

describe("links", () => {
  test("open outside the frame with no opener and no referrer", () => {
    expect(sanitizeHtml(`<a href="https://example.com/a">a</a>`, options).html).toBe(
      '<a href="https://example.com/a" target="_blank" rel="noopener noreferrer nofollow">a</a>',
    );
  });

  test("text naming one site and opening another is flagged", () => {
    expect(links(`<a href="https://paypal.com.evil.example/login">paypal.com</a>`)).toEqual([
      {
        text: "paypal.com",
        href: "https://paypal.com.evil.example/login",
        textHost: "paypal.com",
        hrefHost: "paypal.com.evil.example",
      },
    ]);
    expect(
      links(`<a href="https://evil.example/x"><b>https://www.bank.example/login</b></a>`),
    ).toMatchObject([{ textHost: "bank.example", hrefHost: "evil.example" }]);
  });

  test("a lookalike domain in the text is compared by its punycode", () => {
    // Cyrillic "а" in the text: it reads as paypal.com but is another domain.
    expect(links(`<a href="https://paypal.com/">pаypal.com</a>`)).toMatchObject([
      { textHost: "xn--pypal-4ve.com", hrefHost: "paypal.com" },
    ]);
  });

  test("same site, subdomains, and plain-word links are not flagged", () => {
    expect(
      links(
        [
          `<a href="https://example.com/a">www.example.com</a>`,
          `<a href="https://news.example.com/a">example.com/a</a>`,
          `<a href="https://example.com/a">https://mail.example.com</a>`,
          `<a href="https://click.example.net/r/1">Read the full story</a>`,
          `<a href="mailto:ana@example.com">ana@example.com</a>`,
        ].join(""),
      ),
    ).toEqual([]);
  });
});
