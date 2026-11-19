"use client";

import { useState } from "react";
import { updateRentalTerms } from "@/lib/api";
import type { Product } from "@/lib/types";

/**
 * Edit the delivery lead time (every product) and the daily rate of an occasion
 * product. The customer pays daily rate x days (1-7), once, at checkout. The
 * server validates everything; the checks here only give quick feedback.
 */
export function RentalTermsCard({
  token,
  product,
  onSaved,
}: {
  token: string;
  product: Pick<Product, "id" | "rentalMode" | "occasionDailyRate" | "deliveryLeadDays">;
  onSaved?: () => void;
}) {
  const isOccasion = product.rentalMode === "occasion";
  const [dailyRate, setDailyRate] = useState(product.occasionDailyRate ? String(product.occasionDailyRate) : "");
  const [leadDays, setLeadDays] = useState(String(Number.isInteger(product.deliveryLeadDays) ? product.deliveryLeadDays : 2));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const rate = Number(dailyRate);
  const rateIsValid = Number.isFinite(rate) && rate > 0;

  const onSave = async () => {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const body: { occasionDailyRate?: number; deliveryLeadDays: number } = { deliveryLeadDays: Number(leadDays) };
      if (isOccasion) body.occasionDailyRate = rate;
      await updateRentalTerms(token, product.id, body);
      setMessage("Saved.");
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <h3 className="text-sm font-bold text-zinc-900">Rental terms</h3>

      <label className="mt-3 block text-sm font-semibold text-zinc-700">
        Delivery lead time (days)
        <input
          type="number" min={0} max={30} step={1} value={leadDays}
          onChange={(event) => setLeadDays(event.target.value)}
          className="mt-1 block w-28 rounded-lg border border-zinc-300 px-3 py-2 text-sm"
        />
        <span className="text-xs font-normal text-zinc-500">The earliest rental start is this many days after ordering. Applies to this product only.</span>
      </label>

      {isOccasion ? (
        <label className="mt-4 block text-sm font-semibold text-zinc-700">
          Daily rental price (EUR)
          <input
            type="number" min={0} step="0.01" value={dailyRate}
            onChange={(event) => setDailyRate(event.target.value)}
            className="mt-1 block w-32 rounded-lg border border-zinc-300 px-3 py-2 text-sm"
          />
          <span className="text-xs font-normal text-zinc-500">
            Customers choose 1 to 7 days and pay daily price x days once at checkout.
            {rateIsValid ? ` Example: 1 day = €${rate.toFixed(2)}, 3 days = €${(rate * 3).toFixed(2)}, 7 days = €${(rate * 7).toFixed(2)}.` : ""}
          </span>
        </label>
      ) : null}

      <button
        type="button" disabled={saving || (isOccasion && !rateIsValid)} onClick={() => void onSave()}
        className="mt-4 rounded-lg bg-[rgb(73,153,173)] px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
      >
        {saving ? "Saving..." : "Save rental terms"}
      </button>
      {message ? <p className="mt-2 text-sm text-emerald-700">{message}</p> : null}
      {error ? <p className="mt-2 text-sm text-rose-700">{error}</p> : null}
    </div>
  );
}
