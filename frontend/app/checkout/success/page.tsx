"use client";

import Image from "next/image";
import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ClientNavbar } from "@/components/client-navbar";
import { HomeFooter } from "@/components/home-footer";
import { clearCart } from "@/lib/cart";
import { confirmCheckoutSession } from "@/lib/api";
import { euro, thenLine } from "@/lib/payment-copy";
import { useSiteLocale } from "@/lib/use-site-locale";
import type { Order } from "@/lib/types";

const successCopy = {
  en: {
    title: "Payment Successful",
    oneTime: "Your order has been confirmed. Thank you for renting with Leihfluss.",
    // After the first payment of a recurring rental: nothing implies the rest is paid.
    recurring: "Your first payment was successful and your order is confirmed. The rental is paid in instalments: the remaining payments are charged automatically, one per period, and billing stops by itself after the last one.",
    paidToday: "Paid today", totalRental: "Total rental price",
    session: "Session ID:", shop: "Continue shopping", home: "Go home", loading: "Loading order details...",
    paymentsLeft: (paid: number, all: number) => `${paid} of ${all} rental payments made`,
  },
  de: {
    title: "Zahlung erfolgreich",
    oneTime: "Deine Bestellung ist bestätigt. Danke, dass du bei Leihfluss mietest.",
    recurring: "Deine erste Zahlung war erfolgreich und deine Bestellung ist bestätigt. Die Miete wird in Raten bezahlt: Die weiteren Zahlungen werden automatisch abgebucht, eine pro Periode. Nach der letzten Zahlung endet die Abrechnung von selbst.",
    paidToday: "Heute bezahlt", totalRental: "Gesamtmietpreis",
    session: "Sitzungs-ID:", shop: "Weiter einkaufen", home: "Zur Startseite", loading: "Bestelldetails werden geladen...",
    paymentsLeft: (paid: number, all: number) => `${paid} von ${all} Mietzahlungen geleistet`,
  },
};

function CheckoutSuccessPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("session_id") || "";
  const token = typeof window !== "undefined" ? localStorage.getItem("user_token") || "" : "";
  const { locale } = useSiteLocale("de");
  const t = successCopy[locale];
  const [order, setOrder] = useState<Order | null>(null);

  useEffect(() => {
    if (!sessionId || !token) {
      clearCart();
      return;
    }

    confirmCheckoutSession(token, { sessionId })
      .then((result) => {
        setOrder(result.order);
        clearCart();
      })
      .catch(() => clearCart());
  }, [sessionId, token]);

  return (
    <div className="min-h-screen bg-zinc-50">
      <ClientNavbar />
      <main className="mx-auto w-full max-w-[820px] px-4 py-10">
        <div className="mb-6">
          <Link href="/" className="inline-flex items-center gap-2">
            <Image src="/logo.png" alt="Leihfluss logo" width={120} height={40} priority />
          </Link>
        </div>
        <section className="rounded-2xl border border-zinc-200 bg-white p-8 text-center">
          <p className="text-4xl font-extrabold text-lime-600">{t.title}</p>
          <p className="mt-3 text-zinc-700">{order?.billingMode === "recurring" ? t.recurring : t.oneTime}</p>
          {order?.billingMode === "recurring" && order.recurring ? (
            <div className="mx-auto mt-4 max-w-md rounded-xl bg-zinc-50 px-4 py-3 text-left text-sm text-zinc-800">
              <p>
                {t.paidToday}: <span className="font-semibold">{euro(order.recurring.dueToday, locale)}</span>
              </p>
              {order.recurring.billingCycles - order.recurring.successfulCycles > 0 ? (
                <p className="mt-1">
                  {thenLine(order.recurring.recurringAmount, order.recurring.interval, order.recurring.billingCycles - Math.max(1, order.recurring.successfulCycles), locale)}
                </p>
              ) : null}
              <p className="mt-1">
                {t.totalRental}: <span className="font-semibold">{euro(order.recurring.totalRentalCommitment, locale)}</span>
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                {t.paymentsLeft(Math.max(1, order.recurring.successfulCycles), order.recurring.billingCycles)}
              </p>
            </div>
          ) : null}
          {sessionId ? <p className="mt-2 text-xs text-zinc-500">{t.session} {sessionId}</p> : null}

          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => router.push("/shop")}
              className="rounded-lg bg-lime-500 px-4 py-2 text-sm font-bold text-white"
            >
              {t.shop}
            </button>
            <button
              type="button"
              onClick={() => router.push("/")}
              className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-700"
            >
              {t.home}
            </button>
          </div>
        </section>
      </main>
      <HomeFooter />
    </div>
  );
}

function CheckoutSuccessPageFallback() {
  const { locale } = useSiteLocale("de");
  return (
    <div className="min-h-screen bg-zinc-50">
      <ClientNavbar />
      <main className="mx-auto w-full max-w-[820px] px-4 py-10">
        <section className="rounded-2xl border border-zinc-200 bg-white p-8 text-center">
          <p className="text-sm text-zinc-600">{successCopy[locale].loading}</p>
        </section>
      </main>
      <HomeFooter />
    </div>
  );
}

export default function CheckoutSuccessPage() {
  return (
    <Suspense fallback={<CheckoutSuccessPageFallback />}>
      <CheckoutSuccessPageContent />
    </Suspense>
  );
}
