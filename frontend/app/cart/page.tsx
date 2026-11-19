"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ClientNavbar } from "@/components/client-navbar";
import { HomeFooter } from "@/components/home-footer";
import {
  applyCartLimits,
  clearCart,
  getCartItemMaxQuantity,
  getCartItems,
  removeCartItem,
  subscribeCartChange,
  updateCartItemQuantity,
} from "@/lib/cart";
import { fetchCheckoutQuote } from "@/lib/api";
import { buildProductPath } from "@/lib/product-path";
import { CartItem, CheckoutQuote } from "@/lib/types";
import { durationLabel, localizeIssue } from "@/lib/rental-copy";
import { useSiteLocale } from "@/lib/use-site-locale";
import { PaymentBreakdown } from "@/components/payment-breakdown";
import { euro, lineSummary, paymentCopy } from "@/lib/payment-copy";

const cartCopy = {
  en: {
    title: "Your Cart", subtitle: "Review selected rental period, start date and pricing.", clear: "Clear cart",
    priceChanged: "Pricing for one or more items has been updated since you added them. The amounts shown are current.",
    needAttention: "Some items need attention before checkout:",
    empty: "Your cart is empty.", continueShopping: "Continue shopping",
    brand: "Brand", rental: "Rental:", startDate: "Start date:", qty: "Qty",
    max: (n: number) => `Max ${n} per order`, remove: "Remove",
    itemTotal: "Item total", deposit: "Deposit", delivery: "Delivery",
    summary: "Order Summary", subtotal: "Subtotal", total: "Total", checkout: "Proceed to checkout",
  },
  de: {
    title: "Dein Warenkorb", subtitle: "Prüfe Mietdauer, Startdatum und Preise.", clear: "Warenkorb leeren",
    priceChanged: "Die Preise für einen oder mehrere Artikel wurden seit dem Hinzufügen aktualisiert. Die angezeigten Beträge sind aktuell.",
    needAttention: "Einige Artikel brauchen vor dem Checkout deine Aufmerksamkeit:",
    empty: "Dein Warenkorb ist leer.", continueShopping: "Weiter einkaufen",
    brand: "Marke", rental: "Miete:", startDate: "Startdatum:", qty: "Menge",
    max: (n: number) => `Max. ${n} pro Bestellung`, remove: "Entfernen",
    itemTotal: "Artikelsumme", deposit: "Kaution", delivery: "Lieferung",
    summary: "Bestellübersicht", subtotal: "Zwischensumme", total: "Gesamt", checkout: "Zur Kasse",
  },
};

function formatAmount(value: number) {
  return new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export default function CartPage() {
  const { locale } = useSiteLocale("de");
  const t = cartCopy[locale];
  const [items, setItems] = useState<CartItem[]>(() => (typeof window !== "undefined" ? getCartItems() : []));
  const [fetchedQuote, setFetchedQuote] = useState<CheckoutQuote | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeCartChange(() => {
      setItems(getCartItems());
    });
    return unsubscribe;
  }, []);

  // Re-price against the server whenever the cart changes. The response also
  // carries the current per-product quantity caps, which are written back into
  // the stored cart so the selector and the backend agree.
  useEffect(() => {
    if (items.length === 0) return;

    let cancelled = false;
    fetchCheckoutQuote(
      items.map((item) => ({
        id: item.id,
        productId: item.productId,
        quantity: item.quantity,
        durationValue: item.durationValue,
        durationUnit: item.durationUnit,
        startDate: item.startDate,
      }))
    )
      .then((result) => {
        if (cancelled) return;
        setFetchedQuote(result);

        const limits: Record<string, number> = {};
        result.lines.forEach((line) => {
          if (line.limits?.maxQuantity) limits[line.lineId] = line.limits.maxQuantity;
        });
        // Writing back fires a cart-change event, which refreshes `items`.
        applyCartLimits(limits);
      })
      .catch(() => {
        if (!cancelled) setFetchedQuote(null);
      });

    return () => {
      cancelled = true;
    };
  }, [items]);

  // Masked rather than cleared in the effect, so an empty cart never needs a
  // synchronous setState during render.
  const quote = items.length === 0 ? null : fetchedQuote;

  const quoteLineById = useMemo(() => {
    const map = new Map<string, CheckoutQuote["lines"][number]>();
    quote?.lines.forEach((line) => map.set(line.lineId, line));
    return map;
  }, [quote]);

  // Local arithmetic is only a placeholder until the server quote arrives.
  const localSubtotal = useMemo(
    () => items.reduce((sum, item) => sum + item.unitPrice * Math.max(1, item.quantity), 0),
    [items]
  );
  const localDepositsTotal = useMemo(
    () =>
      items.reduce(
        (sum, item) =>
          sum + (item.depositEnabled ? Number(item.securityDeposit || 0) * Math.max(1, item.quantity) : 0),
        0
      ),
    [items]
  );
  const localDeliveryTotal = useMemo(
    () => items.reduce((sum, item) => sum + Number(item.deliveryFee || 0) * Math.max(1, item.quantity), 0),
    [items]
  );

  const subtotal = quote ? quote.totals.subtotal : localSubtotal;
  const depositsTotal = quote ? quote.totals.depositTotal : localDepositsTotal;
  const deliveryTotal = quote ? quote.totals.deliveryTotal : localDeliveryTotal;
  const grandTotal = quote ? quote.totals.total : localSubtotal + localDepositsTotal + localDeliveryTotal;

  const displayTotals = quote
    ? quote.totals
    : { subtotal, depositTotal: depositsTotal, deliveryTotal, total: grandTotal, dueToday: grandTotal };
  const payCopy = paymentCopy(locale);

  const priceChanged =
    Boolean(quote) && Math.abs(grandTotal - (localSubtotal + localDepositsTotal + localDeliveryTotal)) >= 0.01;
  const cartIssues = quote?.issues ?? [];

  return (
    <div className="min-h-screen bg-zinc-50">
      <ClientNavbar />
      <main className="mx-auto w-full max-w-[1280px] px-4 py-10">
        <div className="mb-6 flex items-end justify-between">
          <div>
            <h1 className="text-4xl font-extrabold text-zinc-900">{t.title}</h1>
            <p className="mt-2 text-sm text-zinc-600">{t.subtitle}</p>
          </div>
          {items.length > 0 ? (
            <button
              type="button"
              onClick={() => clearCart()}
              className="rounded-lg border border-rose-200 bg-white px-4 py-2 text-sm font-semibold text-rose-600"
            >
              {t.clear}
            </button>
          ) : null}
        </div>

        {priceChanged ? (
          <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {t.priceChanged}
          </div>
        ) : null}

        {cartIssues.length > 0 ? (
          <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            <p className="font-semibold">{t.needAttention}</p>
            <ul className="mt-1 list-disc pl-5">
              {cartIssues.map((issue) => (
                <li key={`${issue.lineId}-${issue.code}`}>{localizeIssue(issue, items.find((entry) => entry.id === issue.lineId)?.title || "", locale)}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {items.length === 0 ? (
          <section className="rounded-2xl border border-zinc-200 bg-white p-10 text-center">
            <p className="text-lg font-semibold text-zinc-800">{t.empty}</p>
            <Link href="/shop" className="mt-4 inline-flex rounded-lg bg-lime-500 px-4 py-2 text-sm font-bold text-white">
              {t.continueShopping}
            </Link>
          </section>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
            <section className="space-y-4">
              {items.map((item) => {
                const quoteLine = quoteLineById.get(item.id);
                // Server limit wins; the stored snapshot is the offline fallback.
                const maxQuantity = quoteLine?.limits?.maxQuantity ?? getCartItemMaxQuantity(item);
                const lineIssue = quoteLine?.valid === false && quoteLine.issue ? localizeIssue(quoteLine.issue, item.title, locale) : "";
                const lineSubtotal = quoteLine?.lineSubtotal ?? item.unitPrice * item.quantity;
                const lineDeposit =
                  quoteLine?.lineDeposit ??
                  (item.depositEnabled ? Number(item.securityDeposit || 0) * item.quantity : 0);
                const lineDelivery = quoteLine?.lineDelivery ?? Number(item.deliveryFee || 0) * item.quantity;
                const itemTitle = item.titleI18n?.[locale] || item.title;
                const itemCategory = item.categoryNameI18n?.[locale] || item.categoryName;

                return (
                <article key={item.id} className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
                  <div className="flex gap-4">
                    <div className="h-28 w-28 shrink-0 overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50 p-2">
                      <img src={item.imageUrl} alt={itemTitle} className="h-full w-full object-contain" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <Link
                        href={buildProductPath({ categorySlug: item.categorySlug, productSlug: item.slug })}
                        className="line-clamp-2 text-lg font-bold text-zinc-900 hover:text-lime-700"
                      >
                        {itemTitle}
                      </Link>
                      <p className="mt-1 text-sm text-zinc-600">
                        {item.brandName || t.brand} • {itemCategory}
                      </p>
                      <p className="mt-1 text-sm text-zinc-700">
                        {t.rental} <span className="font-semibold">{durationLabel(item.durationValue, item.durationUnit, locale)}</span>
                      </p>
                      {lineSummary(quoteLine, locale).map((text) => (
                        <p key={text} className="mt-1 text-sm font-medium text-zinc-800">{text}</p>
                      ))}
                      <p className="mt-1 text-sm text-zinc-700">
                        {t.startDate} <span className="font-semibold">{item.startDate}</span>
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-3">
                        <label className="text-sm text-zinc-700">
                          {t.qty}
                          <input
                            type="number"
                            min={1}
                            max={maxQuantity ?? undefined}
                            value={item.quantity}
                            onChange={(event) => updateCartItemQuantity(item.id, Number(event.target.value || 1))}
                            className="ml-2 w-16 rounded-md border border-zinc-300 px-2 py-1 text-sm"
                          />
                        </label>
                        {maxQuantity !== null && maxQuantity <= item.quantity ? (
                          <span className="text-xs text-zinc-500">{t.max(maxQuantity)}</span>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => removeCartItem(item.id)}
                          className="rounded-md border border-rose-200 px-3 py-1.5 text-sm font-semibold text-rose-600"
                        >
                          {t.remove}
                        </button>
                      </div>
                    </div>
                    <div className="text-right">
                      {quoteLine?.billingType === "recurring" ? (
                        <>
                          <p className="text-sm text-zinc-500">{payCopy.dueToday}</p>
                          <p className="text-2xl font-extrabold text-zinc-900">{euro(quoteLine.lineDueToday ?? 0, locale)}</p>
                          <p className="mt-1 text-xs text-zinc-600">{payCopy.totalRental}: {euro(lineSubtotal, locale)}</p>
                        </>
                      ) : (
                        <>
                          <p className="text-sm text-zinc-500">{t.itemTotal}</p>
                          <p className="text-2xl font-extrabold text-zinc-900">EUR {formatAmount(lineSubtotal)}</p>
                        </>
                      )}
                      {lineDeposit > 0 ? (
                        <p className="mt-1 text-xs text-zinc-600">+ {t.deposit} EUR {formatAmount(lineDeposit)}{quoteLine?.billingType === "recurring" ? ` (${payCopy.oneTimeNote})` : ""}</p>
                      ) : null}
                      <p className="mt-1 text-xs text-zinc-600">+ {t.delivery} EUR {formatAmount(lineDelivery)}{quoteLine?.billingType === "recurring" && lineDelivery > 0 ? ` (${payCopy.oneTimeNote})` : ""}</p>
                      {lineIssue ? (
                        <p className="mt-2 max-w-[16rem] text-xs font-semibold text-rose-600">{lineIssue}</p>
                      ) : null}
                    </div>
                  </div>
                </article>
                );
              })}
            </section>

            <aside className="h-fit rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
              <h2 className="text-xl font-bold text-zinc-900">{t.summary}</h2>
              <div className="mt-4">
                <PaymentBreakdown billing={quote?.billing} totals={displayTotals} locale={locale} />
              </div>
              <Link
                href="/checkout"
                className="mt-5 inline-flex w-full items-center justify-center rounded-lg bg-lime-500 px-4 py-3 text-sm font-bold text-white transition hover:bg-lime-600"
              >
                {t.checkout}
              </Link>
            </aside>
          </div>
        )}
      </main>
      <HomeFooter />
    </div>
  );
}
