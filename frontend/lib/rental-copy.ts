import type { Locale } from "@/lib/types";

type Unit = "day" | "week" | "month";

const units = {
  en: { day: ["day", "days"], week: ["week", "weeks"], month: ["month", "months"] },
  de: { day: ["Tag", "Tage"], week: ["Woche", "Wochen"], month: ["Monat", "Monate"] },
} as const;

/** "2 weeks" / "2 Wochen", "1 day" / "1 Tag". */
export function durationLabel(value: number, unit: Unit, locale: Locale): string {
  const [one, many] = units[locale][unit] || units[locale].week;
  return `${value} ${value === 1 ? one : many}`;
}

type Issue = { code?: string; message?: string };

const issueCopy = {
  en: {
    PRODUCT_NOT_FOUND: (t: string) => `${t || "This item"} is no longer available.`,
    PRODUCT_INACTIVE: (t: string) => `${t || "This item"} is no longer available for rent.`,
    INVALID_PERIOD_UNIT: (t: string) => `${t || "This item"} cannot be rented for the selected period type.`,
    PERIOD_UNIT_UNAVAILABLE: (t: string) => `${t || "This item"} cannot be rented for the selected period type.`,
    INVALID_DURATION: (t: string) => `${t || "This item"} is not offered for the selected rental duration.`,
    INVALID_QUANTITY: (t: string) => `${t || "This item"}: the selected quantity is not available.`,
    PRICE_UNAVAILABLE: (t: string) => `${t || "This item"} has no rental price at the moment.`,
    START_DATE_TOO_EARLY: (t: string, d: string) => `${t || "This item"} cannot start that early.${d ? ` Earliest start date: ${d}.` : ""}`,
    INVALID_PRODUCT_REFERENCE: () => "A cart item is not valid any more. Please remove it.",
    INVALID_START_DATE: () => "Please choose a valid start date for this item.",
    MIXED_BILLING_INTERVALS: () => "Weekly and monthly rentals have to be ordered separately. Please check out one billing period at a time.",
  },
  de: {
    PRODUCT_NOT_FOUND: (t: string) => `${t || "Dieser Artikel"} ist nicht mehr verfügbar.`,
    PRODUCT_INACTIVE: (t: string) => `${t || "Dieser Artikel"} kann nicht mehr gemietet werden.`,
    INVALID_PERIOD_UNIT: (t: string) => `${t || "Dieser Artikel"} kann nicht für diese Mietart gemietet werden.`,
    PERIOD_UNIT_UNAVAILABLE: (t: string) => `${t || "Dieser Artikel"} kann nicht für diese Mietart gemietet werden.`,
    INVALID_DURATION: (t: string) => `${t || "Dieser Artikel"} wird für diese Mietdauer nicht angeboten.`,
    INVALID_QUANTITY: (t: string) => `${t || "Dieser Artikel"}: Die gewählte Menge ist nicht verfügbar.`,
    PRICE_UNAVAILABLE: (t: string) => `${t || "Dieser Artikel"} hat derzeit keinen Mietpreis.`,
    START_DATE_TOO_EARLY: (t: string, d: string) => `${t || "Dieser Artikel"} kann nicht so früh starten.${d ? ` Frühester Starttermin: ${d}.` : ""}`,
    INVALID_PRODUCT_REFERENCE: () => "Ein Artikel im Warenkorb ist nicht mehr gültig. Bitte entferne ihn.",
    INVALID_START_DATE: () => "Bitte wähle ein gültiges Startdatum für diesen Artikel.",
    MIXED_BILLING_INTERVALS: () => "Wöchentliche und monatliche Mieten müssen getrennt bestellt werden. Bitte bezahle jeweils eine Abrechnungsperiode pro Bestellung.",
  },
} as const;

/** A customer-facing, localized sentence for a server checkout issue. */
export function localizeIssue(issue: Issue, productTitle: string, locale: Locale): string {
  const make = (issueCopy[locale] as Record<string, (t: string, d: string) => string>)[issue.code || ""];
  if (!make) return issue.message || "";
  const date = /(\d{4}-\d{2}-\d{2})/.exec(issue.message || "")?.[1] || "";
  return make(productTitle, date);
}
