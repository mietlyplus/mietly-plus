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

function formatAmount(value: number) {
  return new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function durationText(value: number, unit: CartItem["durationUnit"]) {
  if (unit === "month") return `${value} month${value > 1 ? "s" : ""}`;
  if (unit === "day") return `${value} day${value > 1 ? "s" : ""}`;
  return `${value} week${value > 1 ? "s" : ""}`;
}

export default function CartPage() {
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

  const priceChanged =
    Boolean(quote) && Math.abs(grandTotal - (localSubtotal + localDepositsTotal + localDeliveryTotal)) >= 0.01;
  const cartIssues = quote?.issues ?? [];

  return (
    <div className="min-h-screen bg-zinc-50">
      <ClientNavbar />
      <main className="mx-auto w-full max-w-[1280px] px-4 py-10">
        <div className="mb-6 flex items-end justify-between">
          <div>
            <h1 className="text-4xl font-extrabold text-zinc-900">Your Cart</h1>
            <p className="mt-2 text-sm text-zinc-600">Review selected rental period, start date and pricing.</p>
          </div>
          {items.length > 0 ? (
            <button
              type="button"
              onClick={() => clearCart()}
              className="rounded-lg border border-rose-200 bg-white px-4 py-2 text-sm font-semibold text-rose-600"
            >
              Clear cart
            </button>
          ) : null}
        </div>

        {priceChanged ? (
          <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            Pricing for one or more items has been updated since you added them. The amounts shown are current.
          </div>
        ) : null}

        {cartIssues.length > 0 ? (
          <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            <p className="font-semibold">Some items need attention before checkout:</p>
            <ul className="mt-1 list-disc pl-5">
              {cartIssues.map((issue) => (
                <li key={`${issue.lineId}-${issue.code}`}>{issue.message}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {items.length === 0 ? (
          <section className="rounded-2xl border border-zinc-200 bg-white p-10 text-center">
            <p className="text-lg font-semibold text-zinc-800">Your cart is empty.</p>
            <Link href="/shop" className="mt-4 inline-flex rounded-lg bg-lime-500 px-4 py-2 text-sm font-bold text-white">
              Continue shopping
            </Link>
          </section>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
            <section className="space-y-4">
              {items.map((item) => {
                const quoteLine = quoteLineById.get(item.id);
                // Server limit wins; the stored snapshot is the offline fallback.
                const maxQuantity = quoteLine?.limits?.maxQuantity ?? getCartItemMaxQuantity(item);
                const lineIssue = quoteLine?.valid === false ? quoteLine.issue?.message ?? "" : "";
                const lineSubtotal = quoteLine?.lineSubtotal ?? item.unitPrice * item.quantity;
                const lineDeposit =
                  quoteLine?.lineDeposit ??
                  (item.depositEnabled ? Number(item.securityDeposit || 0) * item.quantity : 0);
                const lineDelivery = quoteLine?.lineDelivery ?? Number(item.deliveryFee || 0) * item.quantity;

                return (
                <article key={item.id} className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
                  <div className="flex gap-4">
                    <div className="h-28 w-28 shrink-0 overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50 p-2">
                      <img src={item.imageUrl} alt={item.title} className="h-full w-full object-contain" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <Link
                        href={buildProductPath({ categorySlug: item.categorySlug, productSlug: item.slug })}
                        className="line-clamp-2 text-lg font-bold text-zinc-900 hover:text-lime-700"
                      >
                        {item.title}
                      </Link>
                      <p className="mt-1 text-sm text-zinc-600">
                        {item.brandName || "Brand"} • {item.categoryName}
                      </p>
                      <p className="mt-1 text-sm text-zinc-700">
                        Rental: <span className="font-semibold">{durationText(item.durationValue, item.durationUnit)}</span>
                      </p>
                      <p className="mt-1 text-sm text-zinc-700">
                        Start date: <span className="font-semibold">{item.startDate}</span>
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-3">
                        <label className="text-sm text-zinc-700">
                          Qty
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
                          <span className="text-xs text-zinc-500">Max {maxQuantity} per order</span>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => removeCartItem(item.id)}
                          className="rounded-md border border-rose-200 px-3 py-1.5 text-sm font-semibold text-rose-600"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-sm text-zinc-500">Item total</p>
                      <p className="text-2xl font-extrabold text-zinc-900">EUR {formatAmount(lineSubtotal)}</p>
                      {lineDeposit > 0 ? (
                        <p className="mt-1 text-xs text-zinc-600">+ Deposit EUR {formatAmount(lineDeposit)}</p>
                      ) : null}
                      <p className="mt-1 text-xs text-zinc-600">+ Delivery EUR {formatAmount(lineDelivery)}</p>
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
              <h2 className="text-xl font-bold text-zinc-900">Order Summary</h2>
              <div className="mt-4 space-y-2 text-sm text-zinc-700">
                <div className="flex items-center justify-between">
                  <span>Subtotal</span>
                  <span>EUR {formatAmount(subtotal)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Deposit</span>
                  <span>EUR {formatAmount(depositsTotal)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Delivery</span>
                  <span>EUR {formatAmount(deliveryTotal)}</span>
                </div>
              </div>
              <div className="mt-4 border-t border-zinc-200 pt-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-zinc-800">Total</span>
                  <span className="text-2xl font-extrabold text-lime-700">EUR {formatAmount(grandTotal)}</span>
                </div>
              </div>
              <Link
                href="/checkout"
                className="mt-5 inline-flex w-full items-center justify-center rounded-lg bg-lime-500 px-4 py-3 text-sm font-bold text-white transition hover:bg-lime-600"
              >
                Proceed to checkout
              </Link>
            </aside>
          </div>
        )}
      </main>
      <HomeFooter />
    </div>
  );
}
