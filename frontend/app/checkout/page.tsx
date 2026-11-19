"use client";

import { durationLabel, localizeIssue } from "@/lib/rental-copy";
import { useSiteLocale } from "@/lib/use-site-locale";
import { PaymentBreakdown } from "@/components/payment-breakdown";
import { euro, lineSummary, paymentCopy } from "@/lib/payment-copy";
import Image from "next/image";
import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ClientNavbar } from "@/components/client-navbar";
import { HomeFooter } from "@/components/home-footer";
import {
  CheckoutPriceChangedError,
  createCheckoutSession,
  createIdentityVerificationSession,
  fetchCheckoutQuote,
  fetchIdentityStatus,
  getCurrentUser,
  updateUserProfile,
} from "@/lib/api";
import { applyCartLimits, getCartItems } from "@/lib/cart";
import { CartItem, CheckoutQuote } from "@/lib/types";

type Step = 1 | 2 | 3;

type ShippingAddress = {
  fullName: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
};

function formatAmount(value: number) {
  return new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

const checkoutCopy = {
  en: {
    stepShipping: "Shipping Details", stepVerification: "Verification", stepPayment: "Payment",
    canceled: "Checkout was canceled. You can continue anytime.",
    returned: "Returned from verification. Status refreshed.",
    shippingTitle: "Shipping Details", shippingHint: "Save shipping address. It will be reused for future checkouts.",
    useSaved: "Use saved address", enterNew: "Enter new address",
    fullName: "Full name", phone: "Phone", line1: "Address line 1", line2: "Address line 2",
    city: "City", state: "State", postalCode: "Postal code", country: "Country",
    identityTitle: "Identity Verification",
    identityHint: "Verification is mandatory before first checkout. Already verified users can continue directly.",
    checkingStatus: "Checking verification status...", alreadyVerified: "Already verified. Continue.",
    continuePayment: "Continue to Payment", redirecting: "Redirecting...", verifyStripe: "Verify with Stripe",
    paymentTitle: "Payment",
    payHintVerified: "Proceed to secure Stripe payment.",
    payHintNoVerification: "Verification is not required for selected products. Proceed to secure Stripe payment.",
    updatedTotal: "Updated total:", reviewContinue: "Review and continue",
    fixItems: "Please fix these items in your cart first:", goToCart: "Go to cart",
    redirectingStripe: "Redirecting to Stripe Checkout...", confirmingPrices: "Confirming prices...",
    pay: (amount: string) => `Checkout & Pay EUR ${amount}`,
    summary: "Order summary", empty: "Your cart is empty.", confirmingCurrent: "Confirming current prices...",
    priceChanged: "Pricing changed since you added these items. The total below is what you will be charged.",
    priceChangedRefused: "Pricing changed since you reviewed your cart. Please review the updated total and confirm again.",
    qty: "Qty", start: "Start:", delivery: "Delivery", deposit: "Deposit", subtotal: "Subtotal", total: "Total",
    loading: "Loading checkout...",
    errEmpty: "Your cart is empty.", errStill: "Still confirming prices. Please try again in a moment.",
    errNotPriced: "Your cart could not be priced.", errVerifyFirst: "Please complete identity verification first.",
    errShipping: "Please complete shipping details.", errCheckout: "Could not start checkout.",
    errStripeUrl: "Stripe checkout URL not returned.", errQuote: "Could not price your cart.",
    errIdentity: "Could not fetch identity status.", errSaveShipping: "Could not save shipping details.",
    errStartIdentity: "Could not start identity verification.", errStripeVerify: "Stripe verification URL not returned.",
    savedShipping: "Shipping details saved.", alreadyVerifiedMsg: "Already verified. Continue to payment.",
  },
  de: {
    stepShipping: "Lieferadresse", stepVerification: "Verifizierung", stepPayment: "Zahlung",
    canceled: "Der Checkout wurde abgebrochen. Du kannst jederzeit fortfahren.",
    returned: "Zurück von der Verifizierung. Status aktualisiert.",
    shippingTitle: "Lieferadresse", shippingHint: "Speichere deine Lieferadresse. Sie wird für künftige Bestellungen wiederverwendet.",
    useSaved: "Gespeicherte Adresse verwenden", enterNew: "Neue Adresse eingeben",
    fullName: "Vollständiger Name", phone: "Telefon", line1: "Adresszeile 1", line2: "Adresszeile 2",
    city: "Stadt", state: "Bundesland", postalCode: "Postleitzahl", country: "Land",
    identityTitle: "Identitätsprüfung",
    identityHint: "Vor der ersten Bestellung ist eine Verifizierung Pflicht. Bereits verifizierte Kunden können direkt weitermachen.",
    checkingStatus: "Verifizierungsstatus wird geprüft...", alreadyVerified: "Bereits verifiziert. Weiter.",
    continuePayment: "Weiter zur Zahlung", redirecting: "Weiterleitung...", verifyStripe: "Mit Stripe verifizieren",
    paymentTitle: "Zahlung",
    payHintVerified: "Weiter zur sicheren Zahlung über Stripe.",
    payHintNoVerification: "Für die gewählten Produkte ist keine Verifizierung nötig. Weiter zur sicheren Zahlung über Stripe.",
    updatedTotal: "Aktualisierte Summe:", reviewContinue: "Prüfen und fortfahren",
    fixItems: "Bitte korrigiere zuerst diese Artikel im Warenkorb:", goToCart: "Zum Warenkorb",
    redirectingStripe: "Weiterleitung zu Stripe Checkout...", confirmingPrices: "Preise werden bestätigt...",
    pay: (amount: string) => `Jetzt bezahlen EUR ${amount}`,
    summary: "Bestellübersicht", empty: "Dein Warenkorb ist leer.", confirmingCurrent: "Aktuelle Preise werden bestätigt...",
    priceChanged: "Die Preise haben sich seit dem Hinzufügen geändert. Die Summe unten wird dir berechnet.",
    priceChangedRefused: "Die Preise haben sich seit deiner Prüfung des Warenkorbs geändert. Bitte prüfe die neue Summe und bestätige erneut.",
    qty: "Menge", start: "Start:", delivery: "Lieferung", deposit: "Kaution", subtotal: "Zwischensumme", total: "Gesamt",
    loading: "Checkout wird geladen...",
    errEmpty: "Dein Warenkorb ist leer.", errStill: "Preise werden noch bestätigt. Bitte versuche es gleich noch einmal.",
    errNotPriced: "Dein Warenkorb konnte nicht berechnet werden.", errVerifyFirst: "Bitte schließe zuerst die Identitätsprüfung ab.",
    errShipping: "Bitte vervollständige die Lieferadresse.", errCheckout: "Der Checkout konnte nicht gestartet werden.",
    errStripeUrl: "Stripe hat keine Checkout-Adresse geliefert.", errQuote: "Dein Warenkorb konnte nicht berechnet werden.",
    errIdentity: "Der Verifizierungsstatus konnte nicht abgerufen werden.", errSaveShipping: "Die Lieferadresse konnte nicht gespeichert werden.",
    errStartIdentity: "Die Identitätsprüfung konnte nicht gestartet werden.", errStripeVerify: "Stripe hat keine Verifizierungsadresse geliefert.",
    savedShipping: "Lieferadresse gespeichert.", alreadyVerifiedMsg: "Bereits verifiziert. Weiter zur Zahlung.",
  },
};

function isAddressComplete(address: ShippingAddress | null) {
  if (!address) return false;
  return Boolean(
    address.fullName.trim() &&
      address.phone.trim() &&
      address.line1.trim() &&
      address.city.trim() &&
      address.postalCode.trim() &&
      address.country.trim()
  );
}

function CheckoutPageContent() {
  const { locale } = useSiteLocale("de");
  const t = checkoutCopy[locale];
  const router = useRouter();
  const searchParams = useSearchParams();
  const [hydrated, setHydrated] = useState(false);
  const [token, setToken] = useState("");
  const [currentStep, setCurrentStep] = useState<Step>(1);
  const [items, setItems] = useState<CartItem[]>([]);
  const [quote, setQuote] = useState<CheckoutQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(true);
  const [quoteError, setQuoteError] = useState("");
  // Set when the server refuses a charge because pricing moved. Forces the
  // customer to acknowledge the new total before Pay can be pressed again.
  const [repriceNotice, setRepriceNotice] = useState("");
  const [identityVerified, setIdentityVerified] = useState(false);
  const [statusLoading, setStatusLoading] = useState(true);
  const [verificationLoading, setVerificationLoading] = useState(false);
  const [paying, setPaying] = useState(false);
  const [savingAddress, setSavingAddress] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [addressMode, setAddressMode] = useState<"saved" | "new">("new");
  const [profileName, setProfileName] = useState("");
  const [profilePhone, setProfilePhone] = useState<string | null>(null);
  const [savedAddress, setSavedAddress] = useState<ShippingAddress | null>(null);
  const [shippingAddress, setShippingAddress] = useState<ShippingAddress>({
    fullName: "",
    phone: "",
    line1: "",
    line2: "",
    city: "",
    state: "",
    postalCode: "",
    country: "Germany",
  });

  const canceled = searchParams.get("canceled") === "1";
  const returnedFromIdentity = searchParams.get("identity_return") === "1";

  useEffect(() => {
    setHydrated(true);
    const userToken = localStorage.getItem("user_token") || "";
    setToken(userToken);
    setItems(getCartItems());
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (!token) {
      router.replace("/signin");
      return;
    }

    setStatusLoading(true);
    fetchIdentityStatus(token)
      .then((result) => {
        setIdentityVerified(Boolean(result.verified));
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : t.errIdentity);
      })
      .finally(() => setStatusLoading(false));

    getCurrentUser(token)
      .then((payload) => {
        setProfileName(payload.user.name || "");
        setProfilePhone(payload.user.phone || null);
        const profileAddress: ShippingAddress = {
          fullName: String(payload.user.address?.fullName || "").trim(),
          phone: String(payload.user.address?.phone || "").trim(),
          line1: String(payload.user.address?.line1 || "").trim(),
          line2: String(payload.user.address?.line2 || "").trim(),
          city: String(payload.user.address?.city || "").trim(),
          state: String(payload.user.address?.state || "").trim(),
          postalCode: String(payload.user.address?.postalCode || "").trim(),
          country: String(payload.user.address?.country || "").trim(),
        };

        if (isAddressComplete(profileAddress)) {
          setSavedAddress(profileAddress);
          setAddressMode("saved");
          setShippingAddress(profileAddress);
        } else {
          setAddressMode("new");
        }
      })
      .catch(() => {
        setAddressMode("new");
      });
  }, [hydrated, router, token]);

  // The checkout summary must never show an amount other than what Stripe will
  // charge, so totals come from the server quote. The locally cached cart values
  // are only used to detect that a price moved since add-to-cart.
  useEffect(() => {
    if (!hydrated) return;
    if (items.length === 0) {
      setQuote(null);
      setQuoteLoading(false);
      return;
    }

    let cancelled = false;
    setQuoteLoading(true);
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
        setQuote(result);
        setQuoteError("");

        const limits: Record<string, number> = {};
        result.lines.forEach((line) => {
          if (line.limits?.maxQuantity) limits[line.lineId] = line.limits.maxQuantity;
        });
        if (applyCartLimits(limits)) setItems(getCartItems());
      })
      .catch((err) => {
        if (cancelled) return;
        setQuote(null);
        setQuoteError(err instanceof Error ? err.message : t.errQuote);
      })
      .finally(() => {
        if (!cancelled) setQuoteLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [hydrated, items]);

  const quoteLineById = useMemo(() => {
    const map = new Map<string, CheckoutQuote["lines"][number]>();
    quote?.lines.forEach((line) => map.set(line.lineId, line));
    return map;
  }, [quote]);

  const cachedTotal = useMemo(
    () =>
      items.reduce((sum, item) => {
        const quantity = Math.max(1, item.quantity);
        const deposit = item.depositEnabled ? Number(item.securityDeposit || 0) : 0;
        return sum + (item.unitPrice + deposit + Number(item.deliveryFee || 0)) * quantity;
      }, 0),
    [items]
  );

  const subtotal = quote?.totals.subtotal ?? 0;
  const depositTotal = quote?.totals.depositTotal ?? 0;
  const deliveryTotal = quote?.totals.deliveryTotal ?? 0;
  const grandTotal = quote?.totals.total ?? 0;
  // What is charged now. For a recurring rental this is the first period plus
  // one-time delivery and deposit, not the whole term.
  const dueToday = quote?.totals.dueToday ?? 0;
  const payCopy = paymentCopy(locale);
  const summaryTotals = { subtotal, depositTotal, deliveryTotal, total: grandTotal, dueToday };

  const priceChanged = Boolean(quote) && Math.abs(grandTotal - cachedTotal) >= 0.01;
  const quoteIssues = quote?.issues ?? [];
  const cartIsPayable = quote !== null && quote.valid && grandTotal > 0;

  const requiresIdentityVerification = quote
    ? quote.requiresIdentityVerification
    : items.some((item) => item.verificationRequired !== false);
  const checkoutSteps = useMemo(
    () =>
      requiresIdentityVerification
        ? [
            { id: 1 as Step, label: t.stepShipping },
            { id: 2 as Step, label: t.stepVerification },
            { id: 3 as Step, label: t.stepPayment },
          ]
        : [
            { id: 1 as Step, label: t.stepShipping },
            { id: 3 as Step, label: t.stepPayment },
          ],
    [requiresIdentityVerification, t]
  );
  const currentStepIndex = checkoutSteps.findIndex((item) => item.id === currentStep);

  const selectedAddress = addressMode === "saved" && savedAddress ? savedAddress : shippingAddress;

  useEffect(() => {
    if (!requiresIdentityVerification && currentStep === 2) {
      setCurrentStep(3);
    }
  }, [currentStep, requiresIdentityVerification]);

  const onSaveShippingAndContinue = async () => {
    if (!token) return;
    setError("");
    setMessage("");

    if (!isAddressComplete(selectedAddress)) {
      setError(t.errShipping);
      return;
    }

    setSavingAddress(true);
    try {
      const payload = await updateUserProfile(token, {
        name: profileName || selectedAddress.fullName,
        phone: profilePhone,
        address: {
          fullName: selectedAddress.fullName.trim(),
          phone: selectedAddress.phone.trim(),
          line1: selectedAddress.line1.trim(),
          line2: selectedAddress.line2.trim(),
          city: selectedAddress.city.trim(),
          state: selectedAddress.state.trim(),
          postalCode: selectedAddress.postalCode.trim(),
          country: selectedAddress.country.trim(),
        },
      });

      const nextSavedAddress: ShippingAddress = {
        fullName: String(payload.user.address?.fullName || selectedAddress.fullName).trim(),
        phone: String(payload.user.address?.phone || selectedAddress.phone).trim(),
        line1: String(payload.user.address?.line1 || selectedAddress.line1).trim(),
        line2: String(payload.user.address?.line2 || selectedAddress.line2).trim(),
        city: String(payload.user.address?.city || selectedAddress.city).trim(),
        state: String(payload.user.address?.state || selectedAddress.state).trim(),
        postalCode: String(payload.user.address?.postalCode || selectedAddress.postalCode).trim(),
        country: String(payload.user.address?.country || selectedAddress.country).trim(),
      };

      setSavedAddress(nextSavedAddress);
      setAddressMode("saved");
      setMessage(t.savedShipping);
      setCurrentStep(requiresIdentityVerification ? 2 : 3);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.errSaveShipping);
    } finally {
      setSavingAddress(false);
    }
  };

  const onStartIdentityVerification = async () => {
    if (!token) return;
    setVerificationLoading(true);
    setError("");
    setMessage("");
    try {
      const session = await createIdentityVerificationSession(token);
      if (session.verified) {
        setIdentityVerified(true);
        setMessage(t.alreadyVerifiedMsg);
        return;
      }
      if (session.url) {
        window.location.href = session.url;
        return;
      }
      throw new Error(t.errStripeVerify);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.errStartIdentity);
    } finally {
      setVerificationLoading(false);
    }
  };

  const onPayNow = async () => {
    if (!token) return;
    if (items.length === 0) {
      setError(t.errEmpty);
      return;
    }
    if (quoteLoading) {
      setError(t.errStill);
      return;
    }
    if (!cartIsPayable) {
      setError(quoteIssues[0] ? localizeIssue(quoteIssues[0], items.find((entry) => entry.id === quoteIssues[0].lineId)?.title || "", locale) : quoteError || t.errNotPriced);
      return;
    }
    if (requiresIdentityVerification && !identityVerified) {
      setError(t.errVerifyFirst);
      return;
    }
    if (!isAddressComplete(selectedAddress)) {
      setError(t.errShipping);
      setCurrentStep(1);
      return;
    }

    setPaying(true);
    setError("");
    setMessage("");
    setRepriceNotice("");
    try {
      const session = await createCheckoutSession(token, {
        // Precondition only. The server recalculates from the database and
        // refuses with 409 if this no longer matches; it never sets the price.
        expectedTotal: grandTotal,
        expectedDueToday: dueToday,
        // Intent only. Prices, deposits and delivery fees are resolved server-side
        // from the product record, so sending them here would be meaningless.
        items: items.map((item) => ({
          id: item.id,
          productId: item.productId,
          quantity: Math.max(1, item.quantity),
          durationValue: item.durationValue,
          durationUnit: item.durationUnit,
          startDate: item.startDate,
        })),
        shippingAddress: selectedAddress,
      });
      if (!session.url) throw new Error(t.errStripeUrl);
      window.location.href = session.url;
    } catch (err) {
      if (err instanceof CheckoutPriceChangedError) {
        // Do not redirect. Show the server's new total and make the customer
        // confirm it explicitly before another attempt.
        setQuote(err.quote);
        setRepriceNotice(t.priceChangedRefused);
        setPaying(false);
        return;
      }

      setError(err instanceof Error ? err.message : t.errCheckout);
      setPaying(false);
    }
  };

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(73,153,173,0.16)_0%,rgba(73,153,173,0.06)_30%,#f8fafc_65%,#f4f7f9_100%)]">
      <ClientNavbar />

      <main className="mx-auto w-full max-w-[1200px] px-4 py-8">
        <div className="mb-6">
          <Link href="/" className="inline-flex items-center gap-2">
            <Image src="/logo.png" alt="Leihfluss logo" width={120} height={40} priority />
          </Link>
        </div>

        <section className="mb-6 rounded-2xl border border-[rgba(73,153,173,0.24)] bg-white p-5 shadow-[0_14px_40px_-30px_rgba(73,153,173,0.7)]">
          <div
            className={`grid items-center gap-3 text-sm md:text-base ${
              requiresIdentityVerification ? "grid-cols-3" : "grid-cols-2"
            }`}
          >
            {checkoutSteps.map((step, index) => {
              const active = currentStep === step.id;
              const complete = index < currentStepIndex;
              return (
                <div key={step.id} className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      if (index <= currentStepIndex) setCurrentStep(step.id);
                    }}
                    className={`inline-flex h-9 w-9 items-center justify-center rounded-full text-sm font-extrabold ${
                      active || complete
                        ? "bg-[rgb(73,153,173)] text-white"
                        : "bg-[rgba(73,153,173,0.12)] text-[rgb(47,118,135)]"
                    }`}
                  >
                    {String(index + 1).padStart(2, "0")}
                  </button>
                  <span className={`${active ? "font-bold text-zinc-900" : "text-zinc-600"}`}>{step.label}</span>
                  {index < checkoutSteps.length - 1 ? <span className="hidden h-[2px] flex-1 bg-zinc-300 md:block" /> : null}
                </div>
              );
            })}
          </div>
        </section>

        {canceled ? (
          <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {t.canceled}
          </p>
        ) : null}
        {returnedFromIdentity && requiresIdentityVerification ? (
          <p className="mb-4 rounded-lg bg-zinc-100 px-3 py-2 text-sm text-zinc-700">
            {t.returned}
          </p>
        ) : null}
        {message ? (
          <p className="mb-4 rounded-lg bg-[rgba(73,153,173,0.12)] px-3 py-2 text-sm text-[rgb(47,118,135)]">
            {message}
          </p>
        ) : null}
        {error ? <p className="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}

        <section className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <div className="space-y-4">
            {currentStep === 1 ? (
              <article className="rounded-2xl border border-[rgba(73,153,173,0.22)] bg-white p-5 shadow-[0_12px_35px_-28px_rgba(73,153,173,0.65)]">
                <h2 className="text-2xl font-bold text-zinc-900">{t.shippingTitle}</h2>
                <p className="mt-2 text-sm text-zinc-600">{t.shippingHint}</p>

                {savedAddress ? (
                  <div className="mt-4 space-y-3">
                    <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-zinc-200 p-3">
                      <input
                        type="radio"
                        name="addressMode"
                        checked={addressMode === "saved"}
                        onChange={() => setAddressMode("saved")}
                        className="mt-1"
                      />
                      <span className="text-sm text-zinc-700">
                        <span className="block font-semibold text-zinc-900">{t.useSaved}</span>
                        <span className="block">{savedAddress.fullName}</span>
                        <span className="block">{savedAddress.phone}</span>
                        <span className="block">
                          {savedAddress.line1}
                          {savedAddress.line2 ? `, ${savedAddress.line2}` : ""}
                        </span>
                        <span className="block">
                          {savedAddress.city}
                          {savedAddress.state ? `, ${savedAddress.state}` : ""} {savedAddress.postalCode}
                        </span>
                        <span className="block">{savedAddress.country}</span>
                      </span>
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-zinc-200 p-3">
                      <input
                        type="radio"
                        name="addressMode"
                        checked={addressMode === "new"}
                        onChange={() => setAddressMode("new")}
                      />
                      <span className="text-sm font-semibold text-zinc-800">{t.enterNew}</span>
                    </label>
                  </div>
                ) : null}

                {addressMode === "new" || !savedAddress ? (
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <label className="text-sm text-zinc-700">
                      <span className="mb-1 block">{t.fullName}</span>
                      <input
                        value={shippingAddress.fullName}
                        onChange={(e) => setShippingAddress((p) => ({ ...p, fullName: e.target.value }))}
                        className="w-full rounded-lg border border-zinc-300 px-3 py-2 outline-none focus:border-[rgb(73,153,173)]"
                      />
                    </label>
                    <label className="text-sm text-zinc-700">
                      <span className="mb-1 block">{t.phone}</span>
                      <input
                        value={shippingAddress.phone}
                        onChange={(e) => setShippingAddress((p) => ({ ...p, phone: e.target.value }))}
                        className="w-full rounded-lg border border-zinc-300 px-3 py-2 outline-none focus:border-[rgb(73,153,173)]"
                      />
                    </label>
                    <label className="text-sm text-zinc-700 sm:col-span-2">
                      <span className="mb-1 block">{t.line1}</span>
                      <input
                        value={shippingAddress.line1}
                        onChange={(e) => setShippingAddress((p) => ({ ...p, line1: e.target.value }))}
                        className="w-full rounded-lg border border-zinc-300 px-3 py-2 outline-none focus:border-[rgb(73,153,173)]"
                      />
                    </label>
                    <label className="text-sm text-zinc-700 sm:col-span-2">
                      <span className="mb-1 block">{t.line2}</span>
                      <input
                        value={shippingAddress.line2}
                        onChange={(e) => setShippingAddress((p) => ({ ...p, line2: e.target.value }))}
                        className="w-full rounded-lg border border-zinc-300 px-3 py-2 outline-none focus:border-[rgb(73,153,173)]"
                      />
                    </label>
                    <label className="text-sm text-zinc-700">
                      <span className="mb-1 block">{t.city}</span>
                      <input
                        value={shippingAddress.city}
                        onChange={(e) => setShippingAddress((p) => ({ ...p, city: e.target.value }))}
                        className="w-full rounded-lg border border-zinc-300 px-3 py-2 outline-none focus:border-[rgb(73,153,173)]"
                      />
                    </label>
                    <label className="text-sm text-zinc-700">
                      <span className="mb-1 block">{t.state}</span>
                      <input
                        value={shippingAddress.state}
                        onChange={(e) => setShippingAddress((p) => ({ ...p, state: e.target.value }))}
                        className="w-full rounded-lg border border-zinc-300 px-3 py-2 outline-none focus:border-[rgb(73,153,173)]"
                      />
                    </label>
                    <label className="text-sm text-zinc-700">
                      <span className="mb-1 block">{t.postalCode}</span>
                      <input
                        value={shippingAddress.postalCode}
                        onChange={(e) => setShippingAddress((p) => ({ ...p, postalCode: e.target.value }))}
                        className="w-full rounded-lg border border-zinc-300 px-3 py-2 outline-none focus:border-[rgb(73,153,173)]"
                      />
                    </label>
                    <label className="text-sm text-zinc-700">
                      <span className="mb-1 block">{t.country}</span>
                      <input
                        value={shippingAddress.country}
                        onChange={(e) => setShippingAddress((p) => ({ ...p, country: e.target.value }))}
                        className="w-full rounded-lg border border-zinc-300 px-3 py-2 outline-none focus:border-[rgb(73,153,173)]"
                      />
                    </label>
                  </div>
                ) : null}

                <div className="mt-4">
                  <button
                    type="button"
                    onClick={onSaveShippingAndContinue}
                    disabled={savingAddress}
                    className="rounded-lg bg-[rgb(73,153,173)] px-4 py-2 text-sm font-bold text-white transition hover:bg-[rgb(60,138,158)] disabled:opacity-60"
                  >
                    {savingAddress ? "Saving..." : "Save & Continue"}
                  </button>
                </div>
              </article>
            ) : null}

            {currentStep === 2 && requiresIdentityVerification ? (
              <article className="rounded-2xl border border-[rgba(73,153,173,0.22)] bg-white p-5 shadow-[0_12px_35px_-28px_rgba(73,153,173,0.65)]">
                <h2 className="text-2xl font-bold text-zinc-900">{t.identityTitle}</h2>
                <p className="mt-2 text-sm text-zinc-600">
                  {t.identityHint}
                </p>

                {statusLoading ? <p className="mt-4 text-sm text-zinc-500">{t.checkingStatus}</p> : null}

                {!statusLoading && identityVerified ? (
                  <div className="mt-4 space-y-4">
                    <p className="inline-flex rounded-full bg-[rgba(73,153,173,0.14)] px-3 py-1 text-sm font-semibold text-[rgb(47,118,135)]">
                      {t.alreadyVerified}
                    </p>
                    <div>
                      <button
                        type="button"
                        onClick={() => setCurrentStep(3)}
                        className="rounded-lg bg-[rgb(73,153,173)] px-4 py-2 text-sm font-bold text-white transition hover:bg-[rgb(60,138,158)]"
                      >
                        {t.continuePayment}
                      </button>
                    </div>
                  </div>
                ) : null}

                {!statusLoading && !identityVerified ? (
                  <div className="mt-4 space-y-4">
                    <button
                      type="button"
                      onClick={onStartIdentityVerification}
                      disabled={verificationLoading}
                      className="rounded-lg bg-[rgb(73,153,173)] px-4 py-2 text-sm font-bold text-white transition hover:bg-[rgb(60,138,158)] disabled:opacity-60"
                    >
                      {verificationLoading ? t.redirecting : t.verifyStripe}
                    </button>
                  </div>
                ) : null}
              </article>
            ) : null}

            {currentStep === 3 ? (
              <article className="rounded-2xl border border-[rgba(73,153,173,0.22)] bg-white p-5 shadow-[0_12px_35px_-28px_rgba(73,153,173,0.65)]">
                <h2 className="text-2xl font-bold text-zinc-900">{t.paymentTitle}</h2>
                <p className="mt-2 text-sm text-zinc-600">
                  {requiresIdentityVerification
                    ? t.payHintVerified
                    : t.payHintNoVerification}
                </p>
                {repriceNotice ? (
                  <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-900">
                    <p className="font-semibold">{repriceNotice}</p>
                    <p className="mt-1">
                      {t.updatedTotal} <span className="font-bold">{euro(dueToday, locale)}</span> ({payCopy.dueToday})
                    </p>
                    <button
                      type="button"
                      onClick={() => setRepriceNotice("")}
                      className="mt-2 rounded-md border border-amber-400 bg-white px-3 py-1.5 text-sm font-semibold text-amber-900"
                    >
                      {t.reviewContinue}
                    </button>
                  </div>
                ) : null}

                {quoteIssues.length > 0 ? (
                  <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
                    <p className="font-semibold">{t.fixItems}</p>
                    <ul className="mt-1 list-disc pl-5">
                      {quoteIssues.map((issue) => (
                        <li key={`${issue.lineId}-${issue.code}`}>{localizeIssue(issue, items.find((entry) => entry.id === issue.lineId)?.title || "", locale)}</li>
                      ))}
                    </ul>
                    <Link href="/cart" className="mt-2 inline-flex text-sm font-semibold underline">
                      {t.goToCart}
                    </Link>
                  </div>
                ) : null}

                {quote ? (
                  <div className="mt-4 rounded-xl border border-zinc-200 p-4">
                    <PaymentBreakdown billing={quote.billing} totals={summaryTotals} locale={locale} emphasis />
                  </div>
                ) : null}

                <button
                  type="button"
                  onClick={onPayNow}
                  disabled={
                    paying ||
                    quoteLoading ||
                    Boolean(repriceNotice) ||
                    !cartIsPayable ||
                    items.length === 0 ||
                    (requiresIdentityVerification && !identityVerified)
                  }
                  className="mt-4 rounded-lg bg-[rgb(73,153,173)] px-4 py-2 text-sm font-bold text-white transition hover:bg-[rgb(60,138,158)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {paying
                    ? t.redirectingStripe
                    : quoteLoading
                      ? t.confirmingPrices
                      : t.pay(formatAmount(dueToday))}
                </button>
              </article>
            ) : null}
          </div>

          <aside className="h-fit rounded-2xl border border-[rgba(73,153,173,0.22)] bg-white p-5 shadow-[0_16px_36px_-28px_rgba(73,153,173,0.68)]">
            <h3 className="text-xl font-bold text-zinc-900">{t.summary}</h3>
            {items.length === 0 ? (
              <p className="mt-3 text-sm text-zinc-500">{t.empty}</p>
            ) : (
              <>
                {quoteLoading ? (
                  <p className="mt-3 text-xs font-semibold text-zinc-500">{t.confirmingCurrent}</p>
                ) : null}

                {priceChanged ? (
                  <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    {t.priceChanged}
                  </div>
                ) : null}

                {quoteError ? (
                  <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
                    {quoteError}
                  </div>
                ) : null}

                <div className="mt-3 space-y-3">
                  {items.map((item) => {
                    const quoteLine = quoteLineById.get(item.id);
                    const lineSubtotal = quoteLine?.lineSubtotal ?? item.unitPrice * item.quantity;
                    const lineDelivery =
                      quoteLine?.lineDelivery ?? Number(item.deliveryFee || 0) * item.quantity;

                    return (
                      <div key={item.id} className="rounded-lg border border-zinc-200 p-3">
                        <p className="line-clamp-1 text-sm font-semibold text-zinc-900">{item.titleI18n?.[locale] || item.title}</p>
                        <p className="mt-1 text-xs text-zinc-600">
                          {durationLabel(item.durationValue, item.durationUnit, locale)} | {t.qty} {item.quantity}
                        </p>
                        <p className="mt-1 text-xs text-zinc-600">{t.start} {item.startDate}</p>
                        {lineSummary(quoteLine, locale).map((text) => (
                          <p key={text} className="mt-1 text-xs font-medium text-zinc-800">{text}</p>
                        ))}
                        <p className="mt-2 text-sm font-bold text-zinc-900">
                          {quoteLine?.billingType === "recurring"
                            ? `${payCopy.dueToday}: ${euro(quoteLine.lineDueToday ?? 0, locale)}`
                            : `EUR ${formatAmount(lineSubtotal)}`}
                        </p>
                        <p className="mt-1 text-xs text-zinc-600">{t.delivery} EUR {formatAmount(lineDelivery)}</p>
                        {quoteLine?.valid === false ? (
                          <p className="mt-2 text-xs font-semibold text-rose-600">{quoteLine.issue ? localizeIssue(quoteLine.issue, item.title, locale) : ""}</p>
                        ) : null}
                      </div>
                    );
                  })}
                </div>

                <div className="mt-4 border-t border-zinc-200 pt-4">
                  <PaymentBreakdown billing={quote?.billing} totals={summaryTotals} locale={locale} />
                </div>
              </>
            )}
          </aside>
        </section>
      </main>

      <HomeFooter />
    </div>
  );
}

function CheckoutPageFallback() {
  const { locale } = useSiteLocale("de");
  const t = checkoutCopy[locale];
  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(73,153,173,0.16)_0%,rgba(73,153,173,0.06)_30%,#f8fafc_65%,#f4f7f9_100%)]">
      <ClientNavbar />
      <main className="mx-auto w-full max-w-[1200px] px-4 py-8">
        <p className="rounded-lg bg-white px-4 py-3 text-sm text-zinc-600 shadow-sm">{t.loading}</p>
      </main>
      <HomeFooter />
    </div>
  );
}

export default function CheckoutPage() {
  return (
    <Suspense fallback={<CheckoutPageFallback />}>
      <CheckoutPageContent />
    </Suspense>
  );
}
