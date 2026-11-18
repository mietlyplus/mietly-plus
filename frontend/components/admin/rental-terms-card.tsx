"use client";

import { useState } from "react";
import { updateRentalTerms } from "@/lib/api";
import type { Product } from "@/lib/types";

type Row = { days: string; price: string };

/**
 * Edit the delivery lead time (every product) and the day-based prices of an
 * occasion product. The server enforces days 1-7, unique days and price > 0;
 * the checks here only give quick feedback.
 */
export function RentalTermsCard({
  token,
  product,
  onSaved,
}: {
  token: string;
  product: Pick<Product, "id" | "rentalMode" | "occasionPricing" | "deliveryLeadDays">;
  onSaved?: () => void;
}) {
  const isOccasion = product.rentalMode === "occasion";
  const [rows, setRows] = useState<Row[]>(
    (product.occasionPricing || []).map((o) => ({ days: String(o.days), price: String(o.price) }))
  );
  const [leadDays, setLeadDays] = useState(String(Number.isInteger(product.deliveryLeadDays) ? product.deliveryLeadDays : 2));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const setRow = (index: number, patch: Partial<Row>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const usedDays = new Set(rows.map((row) => Number(row.days)));
  const nextFreeDay = [1, 2, 3, 4, 5, 6, 7].find((day) => !usedDays.has(day));

  const onSave = async () => {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const body: { occasionPricing?: { days: number; price: number }[]; deliveryLeadDays: number } = {
        deliveryLeadDays: Number(leadDays),
      };
      if (isOccasion) body.occasionPricing = rows.map((row) => ({ days: Number(row.days), price: Number(row.price) }));
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
        <div className="mt-4">
          <p className="text-sm font-semibold text-zinc-700">Day-based prices (1-7 days, EUR)</p>
          <ul className="mt-2 space-y-2">
            {rows.map((row, index) => (
              <li key={index} className="flex items-center gap-2">
                <input
                  type="number" min={1} max={7} step={1} value={row.days} aria-label="Days"
                  onChange={(event) => setRow(index, { days: event.target.value })}
                  className="w-20 rounded-lg border border-zinc-300 px-2 py-1.5 text-sm"
                />
                <span className="text-sm text-zinc-600">day(s) =</span>
                <input
                  type="number" min={0} step="0.01" value={row.price} aria-label="Price"
                  onChange={(event) => setRow(index, { price: event.target.value })}
                  className="w-28 rounded-lg border border-zinc-300 px-2 py-1.5 text-sm"
                />
                <button type="button" onClick={() => setRows((current) => current.filter((_, i) => i !== index))} className="text-sm text-rose-700 underline">
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button" disabled={nextFreeDay === undefined}
            onClick={() => nextFreeDay !== undefined && setRows((current) => [...current, { days: String(nextFreeDay), price: "" }])}
            className="mt-2 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-semibold disabled:opacity-50"
          >
            Add a day option
          </button>
        </div>
      ) : null}

      <button
        type="button" disabled={saving} onClick={() => void onSave()}
        className="mt-4 rounded-lg bg-[rgb(73,153,173)] px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
      >
        {saving ? "Saving..." : "Save rental terms"}
      </button>
      {message ? <p className="mt-2 text-sm text-emerald-700">{message}</p> : null}
      {error ? <p className="mt-2 text-sm text-rose-700">{error}</p> : null}
    </div>
  );
}
