import { getLocales } from "expo-localization";
import { useCrmSettings } from "./crm.ts";

const FALLBACK = "USD";

/** An ISO 4217 code: three capital letters. */
export const isCurrencyCode = (code: string) => /^[A-Z]{3}$/.test(code);

/** The currency of the phone's region (its locale's), else US dollars. */
export function deviceCurrency() {
  try {
    const code = getLocales()[0]?.currencyCode;
    return code && isCurrencyCode(code) ? code : FALLBACK;
  } catch {
    return FALLBACK;
  }
}

/**
 * The currency a deal's value is written in (ADR 0054 decision 7): the deal's own, else the
 * workspace's default, else the phone's. A value is never sent without one.
 */
export function useDealCurrency(own: string | null | undefined) {
  const settings = useCrmSettings();
  const fallback = settings.data?.defaultCurrency ?? deviceCurrency();
  return { currency: own ?? fallback, ready: !!own || !settings.isPending };
}
