// CSS scans for the sanitizer (`./html.ts`): plain string passes, no DOM.

// CSS escapes can spell `url(` in ways a scan cannot see; image-set(), image(), src() take
// URLs outside url(); expression() is old IE script. All rare in mail: drop such CSS.
export const CSS_UNSAFE = /\\|image-set\s*\(|\bimage\s*\(|\bsrc\s*\(|expression\s*\(/i;

/**
 * A style sheet without its innermost rules (`selector { … }`) that hold anything `CSS_UNSAFE`
 * matches. One escaped selector (`.sm\:w-full`, common in generated mail) used to cost the
 * whole sheet, and with it the sender's fonts and colours. Whatever is left is checked again
 * whole, so no escape survives to hide a fetch from the scans after this. One linear pass.
 */
export function dropUnsafeRules(css: string): string {
  let out = "";
  let copied = 0;
  let segment = 0;
  let ruleStart = -1;
  for (let i = 0; i < css.length; i++) {
    const char = css[i];
    if (char === "{") {
      ruleStart = segment;
      segment = i + 1;
    } else if (char === "}") {
      if (ruleStart >= 0 && CSS_UNSAFE.test(css.slice(ruleStart, i + 1))) {
        out += css.slice(copied, ruleStart);
        copied = i + 1;
      }
      ruleStart = -1;
      segment = i + 1;
    }
  }
  return out + css.slice(copied);
}

// Both scans jump past each match, so they stay linear on hostile input (the regexes they
// replace were quadratic on a run of "url(").

/** Removes `@import` rules, each up to its `;` (or the end of the CSS). */
export function removeImports(css: string): string {
  const pattern = /@import/gi;
  let out = "";
  let from = 0;
  for (let match = pattern.exec(css); match; match = pattern.exec(css)) {
    out += css.slice(from, match.index);
    const end = css.indexOf(";", pattern.lastIndex);
    from = end === -1 ? css.length : end + 1;
    pattern.lastIndex = from;
  }
  return out + css.slice(from);
}

/**
 * Replaces each `url(…)` with `replace(…)`. Returns null for an unterminated `url(`: browsers
 * close it at the end of the CSS and load it, so the whole CSS has to go.
 */
export function replaceUrls(css: string, replace: (raw: string) => string): string | null {
  const pattern = /url\(/gi;
  let out = "";
  let from = 0;
  for (let match = pattern.exec(css); match; match = pattern.exec(css)) {
    const end = css.indexOf(")", pattern.lastIndex);
    if (end === -1) return null;
    out += css.slice(from, match.index) + replace(css.slice(pattern.lastIndex, end));
    from = end + 1;
    pattern.lastIndex = from;
  }
  return out + css.slice(from);
}
