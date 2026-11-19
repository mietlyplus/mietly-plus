import type { CheckoutBilling, CheckoutQuoteLine, Locale } from "@/lib/types";

/** "20,00" (de-DE grouping, two decimals). */
export function formatMoney(value: number): string {
  return new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

/** "€20,00" in English, "20,00 €" in German. */
export function euro(value: number, locale: Locale): string {
  return locale === "de" ? `${formatMoney(value)} €` : `€${formatMoney(value)}`;
}

const copy = {
  en: {
    perWeek: "week", perMonth: "month", perDay: "day",
    weekly: "weekly", monthly: "monthly",
    duration: "Rental duration",
    dueToday: "Due today",
    dueTodayDetailRecurring: "first payment, plus one-time delivery and deposit",
    dueTodayDetailOneTime: "paid in full at checkout",
    then: "Then",
    morePayments: (n: number) => (n === 1 ? "1 more payment" : `${n} more payments`),
    totalRental: "Total rental price",
    oneTime: "One-time delivery and deposit",
    oneTimeShort: "one-time delivery/deposit",
    oneTimeLabel: "one-time",
    oneTimeNote: "charged once, not every period",
    notChargedYet: "The remaining rental payments are charged automatically, one per period. Billing stops by itself after the last one.",
    occasionLine: (rate: string, days: number, total: string) => `${rate}/day × ${days} ${days === 1 ? "day" : "days"} = ${total}`,
    days: "days", day: "day", weeks: "weeks", week: "week", months: "months", month: "month",
  },
  de: {
    perWeek: "Woche", perMonth: "Monat", perDay: "Tag",
    weekly: "wöchentlich", monthly: "monatlich",
    duration: "Mietdauer",
    dueToday: "Heute fällig",
    dueTodayDetailRecurring: "erste Zahlung, plus einmalige Lieferung und Kaution",
    dueTodayDetailOneTime: "wird beim Checkout vollständig bezahlt",
    then: "Danach",
    morePayments: (n: number) => (n === 1 ? "1 weitere Zahlung" : `${n} weitere Zahlungen`),
    totalRental: "Gesamtmietpreis",
    oneTime: "Einmalig: Lieferung und Kaution",
    oneTimeShort: "einmalige Lieferung/Kaution",
    oneTimeLabel: "einmalig",
    oneTimeNote: "wird einmal berechnet, nicht in jeder Periode",
    notChargedYet: "Die weiteren Mietzahlungen werden automatisch abgebucht, eine pro Periode. Nach der letzten Zahlung endet die Abrechnung von selbst.",
    occasionLine: (rate: string, days: number, total: string) => `${rate}/Tag × ${days} ${days === 1 ? "Tag" : "Tage"} = ${total}`,
    days: "Tage", day: "Tag", weeks: "Wochen", week: "Woche", months: "Monate", month: "Monat",
  },
} as const;

export function paymentCopy(locale: Locale) {
  return copy[locale];
}

/** "€20,00 / week" for a standard rental period price. */
export function perPeriodLabel(amount: number, unit: "day" | "week" | "month", locale: Locale): string {
  const t = copy[locale];
  const label = unit === "month" ? t.perMonth : unit === "day" ? t.perDay : t.perWeek;
  return `${euro(amount, locale)} / ${label}`;
}

/** "Then: €20,00 weekly for 2 more payments" / "Danach: 20,00 € wöchentlich, 2 weitere Zahlungen". */
export function thenLine(amount: number, interval: "" | "week" | "month", payments: number, locale: Locale): string {
  const t = copy[locale];
  const cadence = interval === "month" ? t.monthly : t.weekly;
  return locale === "de"
    ? `${t.then}: ${euro(amount, locale)} ${cadence}, ${t.morePayments(payments)}`
    : `${t.then}: ${euro(amount, locale)} ${cadence} for ${t.morePayments(payments)}`;
}

export function upcomingLines(billing: CheckoutBilling, locale: Locale): string[] {
  return billing.upcoming.map((run) => thenLine(run.amount, billing.interval, run.payments, locale));
}

/** One cart line, described the way the customer pays for it. */
export function lineSummary(line: CheckoutQuoteLine | undefined, locale: Locale): string[] {
  if (!line || line.valid === false || !line.durationUnit || line.durationValue === undefined) return [];
  const t = copy[locale];
  if (line.durationUnit === "day") {
    // Occasion: daily rate x days, paid once.
    return [t.occasionLine(euro(line.baseUnitPrice ?? 0, locale), line.durationValue, euro(line.unitPrice ?? 0, locale))];
  }
  const rate = perPeriodLabel(line.baseUnitPrice ?? 0, line.durationUnit, locale);
  if (line.billingType === "recurring") {
    return [rate, thenLine(line.recurringPerPeriod ?? 0, line.durationUnit, line.remainingPayments ?? 0, locale)];
  }
  return [rate];
}
