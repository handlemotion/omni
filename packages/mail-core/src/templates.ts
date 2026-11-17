/** The variables a template may use, by name. Unknown names render empty and are reported. */
export const TEMPLATE_VARIABLES = [
  "customer.name",
  "customer.first_name",
  "customer.email",
  "customer.company",
  "agent.name",
  "agent.first_name",
  "agent.email",
  "inbox.address",
  "org.name",
] as const;

export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];
export type TemplateValues = Partial<Record<TemplateVariable, string | null>>;

const PATTERN = /\{\{([^{}|]*)(?:\|([^{}]*))?\}\}/g;
const NAME = /^[a-z_]+(?:\.[a-z_]+)*$/i;

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** The first word of a name, for `first_name`: "Luis Pérez" → "Luis". */
export function firstName(name: string | null | undefined) {
  return name?.trim().split(/\s+/)[0] || null;
}

/**
 * Fills a template. A variable with no value takes its fallback, else renders empty and is
 * listed in `missing` so the composer can point at it before sending. With `html`, values are
 * escaped: a customer's name is untrusted text.
 */
export function renderTemplate(
  template: string,
  values: TemplateValues,
  options: { html?: boolean } = {},
) {
  const missing = new Set<string>();
  const text = template.replace(PATTERN, (match, rawName: string, rawFallback?: string) => {
    const trimmed = rawName.trim();
    if (!NAME.test(trimmed)) return match;
    const name = trimmed.toLowerCase();
    const own = Object.hasOwn(values, name) ? values[name as TemplateVariable] : undefined;
    const given = typeof own === "string" ? own.trim() : "";
    const fallback = rawFallback?.trim() ?? "";
    if (!given && !fallback) missing.add(name);
    const value = given || fallback;
    return options.html ? escapeHtml(value) : value;
  });
  return { text, missing: [...missing] } satisfies { text: string; missing: string[] };
}
