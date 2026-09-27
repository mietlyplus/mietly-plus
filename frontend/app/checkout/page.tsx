"use client";

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

function durationText(value: number, unit: CartItem["durationUnit"]) {
  if (unit === "month") return `${value} month${value > 1 ? "s" : ""}`;
  if (unit === "day") return `${value} day${value > 1 ? "s" : ""}`;
  return `${value} week${value > 1 ? "s" : ""}`;
}

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
        setError(err instanceof Error ? err.message : "Could not fetch identity status.");
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
        setQuoteError(err instanceof Error ? err.message : "Could not price your cart.");
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
            { id: 1 as Step, label: "Shipping Details" },
            { id: 2 as Step, label: "Verification" },
            { id: 3 as Step, label: "Payment" },
          ]
        : [
            { id: 1 as Step, label: "Shipping Details" },
            { id: 3 as Step, label: "Payment" },
          ],
    [requiresIdentityVerification]
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
      setError("Please complete shipping details.");
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
      setMessage("Shipping details saved.");
      setCurrentStep(requiresIdentityVerification ? 2 : 3);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save shipping details.");
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
        setMessage("Already verified. Continue to payment.");
        return;
      }
      if (session.url) {
        window.location.href = session.url;
        return;
      }
      throw new Error("Stripe verification URL not returned.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start identity verification.");
    } finally {
      setVerificationLoading(false);
    }
  };

  const onPayNow = async () => {
    if (!token) return;
    if (items.length === 0) {
      setError("Your cart is empty.");
      return;
    }
    if (quoteLoading) {
      setError("Still confirming prices. Please try again in a moment.");
      return;
    }
    if (!cartIsPayable) {
      setError(quoteIssues[0]?.message || quoteError || "Your cart could not be priced.");
      return;
    }
    if (requiresIdentityVerification && !identityVerified) {
      setError("Please complete identity verification first.");
      return;
    }
    if (!isAddressComplete(selectedAddress)) {
      setError("Please complete shipping details.");
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
      if (!session.url) throw new Error("Stripe checkout URL not returned.");
      window.location.href = session.url;
    } catch (err) {
      if (err instanceof CheckoutPriceChangedError) {
        // Do not redirect. Show the server's new total and make the customer
        // confirm it explicitly before another attempt.
        setQuote(err.quote);
        setRepriceNotice(err.message);
        setPaying(false);
        return;
      }

      setError(err instanceof Error ? err.message : "Could not start checkout.");
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
            Checkout was canceled. You can continue anytime.
          </p>
        ) : null}
        {returnedFromIdentity && requiresIdentityVerification ? (
          <p className="mb-4 rounded-lg bg-zinc-100 px-3 py-2 text-sm text-zinc-700">
            Returned from verification. Status refreshed.
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
                <h2 className="text-2xl font-bold text-zinc-900">Shipping Details</h2>
                <p className="mt-2 text-sm text-zinc-600">Save shipping address. It will be reused for future checkouts.</p>

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
                        <span className="block font-semibold text-zinc-900">Use saved address</span>
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
                      <span className="text-sm font-semibold text-zinc-800">Enter new address</span>
                    </label>
                  </div>
                ) : null}

                {addressMode === "new" || !savedAddress ? (
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <label className="text-sm text-zinc-700">
                      <span className="mb-1 block">Full name</span>
                      <input
                        value={shippingAddress.fullName}
                        onChange={(e) => setShippingAddress((p) => ({ ...p, fullName: e.target.value }))}
                        className="w-full rounded-lg border border-zinc-300 px-3 py-2 outline-none focus:border-[rgb(73,153,173)]"
                      />
                    </label>
                    <label className="text-sm text-zinc-700">
                      <span className="mb-1 block">Phone</span>
                      <input
                        value={shippingAddress.phone}
                        onChange={(e) => setShippingAddress((p) => ({ ...p, phone: e.target.value }))}
                        className="w-full rounded-lg border border-zinc-300 px-3 py-2 outline-none focus:border-[rgb(73,153,173)]"
                      />
                    </label>
                    <label className="text-sm text-zinc-700 sm:col-span-2">
                      <span className="mb-1 block">Address line 1</span>
                      <input
                        value={shippingAddress.line1}
                        onChange={(e) => setShippingAddress((p) => ({ ...p, line1: e.target.value }))}
                        className="w-full rounded-lg border border-zinc-300 px-3 py-2 outline-none focus:border-[rgb(73,153,173)]"
                      />
                    </label>
                    <label className="text-sm text-zinc-700 sm:col-span-2">
                      <span className="mb-1 block">Address line 2</span>
                      <input
                        value={shippingAddress.line2}
                        onChange={(e) => setShippingAddress((p) => ({ ...p, line2: e.target.value }))}
                        className="w-full rounded-lg border border-zinc-300 px-3 py-2 outline-none focus:border-[rgb(73,153,173)]"
                      />
                    </label>
                    <label className="text-sm text-zinc-700">
                      <span className="mb-1 block">City</span>
                      <input
                        value={shippingAddress.city}
                        onChange={(e) => setShippingAddress((p) => ({ ...p, city: e.target.value }))}
                        className="w-full rounded-lg border border-zinc-300 px-3 py-2 outline-none focus:border-[rgb(73,153,173)]"
                      />
                    </label>
                    <label className="text-sm text-zinc-700">
                      <span className="mb-1 block">State</span>
                      <input
                        value={shippingAddress.state}
                        onChange={(e) => setShippingAddress((p) => ({ ...p, state: e.target.value }))}
                        className="w-full rounded-lg border border-zinc-300 px-3 py-2 outline-none focus:border-[rgb(73,153,173)]"
                      />
                    </label>
                    <label className="text-sm text-zinc-700">
                      <span className="mb-1 block">Postal code</span>
                      <input
                        value={shippingAddress.postalCode}
                        onChange={(e) => setShippingAddress((p) => ({ ...p, postalCode: e.target.value }))}
                        className="w-full rounded-lg border border-zinc-300 px-3 py-2 outline-none focus:border-[rgb(73,153,173)]"
                      />
                    </label>
                    <label className="text-sm text-zinc-700">
                      <span className="mb-1 block">Country</span>
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
                <h2 className="text-2xl font-bold text-zinc-900">Identity Verification</h2>
                <p className="mt-2 text-sm text-zinc-600">
                  Verification is mandatory before first checkout. Already verified users can continue directly.
                </p>

                {statusLoading ? <p className="mt-4 text-sm text-zinc-500">Checking verification status...</p> : null}

                {!statusLoading && identityVerified ? (
                  <div className="mt-4 space-y-4">
                    <p className="inline-flex rounded-full bg-[rgba(73,153,173,0.14)] px-3 py-1 text-sm font-semibold text-[rgb(47,118,135)]">
                      Already verified. Continue.
                    </p>
                    <div>
                      <button
                        type="button"
                        onClick={() => setCurrentStep(3)}
                        className="rounded-lg bg-[rgb(73,153,173)] px-4 py-2 text-sm font-bold text-white transition hover:bg-[rgb(60,138,158)]"
                      >
                        Continue to Payment
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
                      {verificationLoading ? "Redirecting..." : "Verify with Stripe"}
                    </button>
                  </div>
                ) : null}
              </article>
            ) : null}

            {currentStep === 3 ? (
              <article className="rounded-2xl border border-[rgba(73,153,173,0.22)] bg-white p-5 shadow-[0_12px_35px_-28px_rgba(73,153,173,0.65)]">
                <h2 className="text-2xl font-bold text-zinc-900">Payment</h2>
                <p className="mt-2 text-sm text-zinc-600">
                  {requiresIdentityVerification
                    ? "Proceed to secure Stripe payment."
                    : "Verification is not required for selected products. Proceed to secure Stripe payment."}
                </p>
                {repriceNotice ? (
                  <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-900">
                    <p className="font-semibold">{repriceNotice}</p>
                    <p className="mt-1">
                      Updated total: <span className="font-bold">EUR {formatAmount(grandTotal)}</span>
                    </p>
                    <button
                      type="button"
                      onClick={() => setRepriceNotice("")}
                      className="mt-2 rounded-md border border-amber-400 bg-white px-3 py-1.5 text-sm font-semibold text-amber-900"
                    >
                      Review and continue
                    </button>
                  </div>
                ) : null}

                {quoteIssues.length > 0 ? (
                  <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
                    <p className="font-semibold">Please fix these items in your cart first:</p>
                    <ul className="mt-1 list-disc pl-5">
                      {quoteIssues.map((issue) => (
                        <li key={`${issue.lineId}-${issue.code}`}>{issue.message}</li>
                      ))}
                    </ul>
                    <Link href="/cart" className="mt-2 inline-flex text-sm font-semibold underline">
                      Go to cart
                    </Link>
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
                    ? "Redirecting to Stripe Checkout..."
                    : quoteLoading
                      ? "Confirming prices..."
                      : `Checkout & Pay EUR ${formatAmount(grandTotal)}`}
                </button>
              </article>
            ) : null}
          </div>

          <aside className="h-fit rounded-2xl border border-[rgba(73,153,173,0.22)] bg-white p-5 shadow-[0_16px_36px_-28px_rgba(73,153,173,0.68)]">
            <h3 className="text-xl font-bold text-zinc-900">Order summary</h3>
            {items.length === 0 ? (
              <p className="mt-3 text-sm text-zinc-500">Your cart is empty.</p>
            ) : (
              <>
                {quoteLoading ? (
                  <p className="mt-3 text-xs font-semibold text-zinc-500">Confirming current prices...</p>
                ) : null}

                {priceChanged ? (
                  <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    Pricing changed since you added these items. The total below is what you will be charged.
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
                        <p className="line-clamp-1 text-sm font-semibold text-zinc-900">{item.title}</p>
                        <p className="mt-1 text-xs text-zinc-600">
                          {durationText(item.durationValue, item.durationUnit)} | Qty {item.quantity}
                        </p>
                        <p className="mt-1 text-xs text-zinc-600">Start: {item.startDate}</p>
                        <p className="mt-2 text-sm font-bold text-zinc-900">EUR {formatAmount(lineSubtotal)}</p>
                        <p className="mt-1 text-xs text-zinc-600">Delivery EUR {formatAmount(lineDelivery)}</p>
                        {quoteLine?.valid === false ? (
                          <p className="mt-2 text-xs font-semibold text-rose-600">{quoteLine.issue?.message}</p>
                        ) : null}
                      </div>
                    );
                  })}
                </div>

                <div className="mt-4 border-t border-zinc-200 pt-4 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-600">Subtotal</span>
                    <span className="font-semibold text-zinc-900">EUR {formatAmount(subtotal)}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between">
                    <span className="text-zinc-600">Deposit</span>
                    <span className="font-semibold text-zinc-900">EUR {formatAmount(depositTotal)}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between">
                    <span className="text-zinc-600">Delivery</span>
                    <span className="font-semibold text-zinc-900">EUR {formatAmount(deliveryTotal)}</span>
                  </div>
                  <div className="mt-3 flex items-center justify-between border-t border-zinc-200 pt-3">
                    <span className="font-semibold text-zinc-800">Total</span>
                    <span className="text-2xl font-extrabold text-[rgb(47,118,135)]">EUR {formatAmount(grandTotal)}</span>
                  </div>
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
  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(73,153,173,0.16)_0%,rgba(73,153,173,0.06)_30%,#f8fafc_65%,#f4f7f9_100%)]">
      <ClientNavbar />
      <main className="mx-auto w-full max-w-[1200px] px-4 py-8">
        <p className="rounded-lg bg-white px-4 py-3 text-sm text-zinc-600 shadow-sm">Loading checkout...</p>
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
