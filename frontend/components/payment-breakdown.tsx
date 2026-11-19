import type { CheckoutBilling, Locale } from "@/lib/types";
import { euro, paymentCopy, upcomingLines } from "@/lib/payment-copy";

type Props = {
  billing: CheckoutBilling | null | undefined;
  totals: { subtotal: number; depositTotal: number; deliveryTotal: number; total: number; dueToday: number };
  locale: Locale;
  /** Larger type for the checkout summary. */
  emphasis?: boolean;
};

/**
 * What the customer pays today and what follows. Every number comes from the
 * server quote; this component only lays it out.
 */
export function PaymentBreakdown({ billing, totals, locale, emphasis = false }: Props) {
  const t = paymentCopy(locale);
  const recurring = billing?.mode === "recurring";
  const oneTimeCharges = totals.depositTotal + totals.deliveryTotal;

  return (
    <div className="space-y-2 text-sm text-zinc-700">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-zinc-900">{t.dueToday}</p>
          <p className="text-xs text-zinc-500">{recurring ? t.dueTodayDetailRecurring : t.dueTodayDetailOneTime}</p>
        </div>
        <p className={`${emphasis ? "text-2xl" : "text-xl"} font-extrabold text-lime-700`}>{euro(totals.dueToday, locale)}</p>
      </div>

      {recurring && billing ? (
        <div className="rounded-lg bg-zinc-50 px-3 py-2">
          {upcomingLines(billing, locale).map((line) => (
            <p key={line} className="font-medium text-zinc-800">{line}</p>
          ))}
          <p className="mt-1 text-xs text-zinc-500">{t.notChargedYet}</p>
        </div>
      ) : null}

      <div className="flex items-center justify-between border-t border-zinc-200 pt-2">
        <span>{t.totalRental}</span>
        <span className="font-semibold text-zinc-900">{euro(totals.subtotal, locale)}</span>
      </div>
      {oneTimeCharges > 0 ? (
        <div className="flex items-center justify-between">
          <span>
            {t.oneTime} <span className="text-xs text-zinc-500">({t.oneTimeNote})</span>
          </span>
          <span className="font-semibold text-zinc-900">{euro(oneTimeCharges, locale)}</span>
        </div>
      ) : null}
    </div>
  );
}
