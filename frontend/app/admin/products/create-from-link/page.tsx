"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  createProductDraft,
  fetchAiProviderStatus,
  uploadProductImage,
} from "@/lib/api";
import { AiProviderStatus } from "@/lib/types";

/** Stable per-attempt key so a double tap on a phone cannot create two drafts. */
function newSubmissionKey() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

type Photo = { id: string; url: string; name: string };

export default function CreateFromLinkPage() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [providers, setProviders] = useState<AiProviderStatus | null>(null);

  const [sourceUrl, setSourceUrl] = useState("");
  const [weeklyPrice, setWeeklyPrice] = useState("");
  const [monthlyPrice, setMonthlyPrice] = useState("");
  const [instruction, setInstruction] = useState("");
  const [photos, setPhotos] = useState<Photo[]>([]);

  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  // Held across retries so a resubmission after a network blip is deduplicated.
  const submissionKeyRef = useRef(newSubmissionKey());

  useEffect(() => {
    const stored = localStorage.getItem("admin_token") || "";
    setToken(stored);
    if (!stored) return;
    fetchAiProviderStatus(stored).then(setProviders).catch(() => setProviders(null));
  }, []);

  const canSubmit = useMemo(() => {
    const weekly = Number(weeklyPrice);
    const monthly = Number(monthlyPrice);
    return (
      (sourceUrl.trim().length > 0 || photos.length > 0) &&
      Number.isFinite(weekly) && weekly > 0 &&
      Number.isFinite(monthly) && monthly > 0 &&
      !submitting && !uploading
    );
  }, [sourceUrl, weeklyPrice, monthlyPrice, photos.length, submitting, uploading]);

  const onPhotosSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (!files.length || !token) return;

    setUploading(true);
    setError("");
    try {
      const added: Photo[] = [];
      for (const file of files.slice(0, 5 - photos.length)) {
        const url = await uploadProductImage(file, token);
        added.push({ id: `${file.name}-${Date.now()}-${added.length}`, url, name: file.name });
      }
      setPhotos((prev) => [...prev, ...added].slice(0, 5));
      setStatus(`${added.length} photo(s) added.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Photo upload failed.");
    } finally {
      setUploading(false);
    }
  };

  const onSubmit = async () => {
    if (!token || !canSubmit) return;
    setSubmitting(true);
    setError("");
    setStatus("Reading the product page and drafting the listing…");

    try {
      const draft = await createProductDraft(token, {
        sourceUrl: sourceUrl.trim(),
        weeklyPrice: Number(weeklyPrice),
        monthlyPrice: Number(monthlyPrice),
        instruction: instruction.trim(),
        imageUrls: photos.map((photo) => photo.url),
        submissionKey: submissionKeyRef.current,
      });
      router.push(`/admin/products/draft/${draft.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the draft.");
      setStatus("");
      setSubmitting(false);
    }
  };

  if (!token) {
    return <p className="text-sm text-zinc-600">Admin token missing. Please sign in again.</p>;
  }

  return (
    <section className="mx-auto w-full max-w-xl">
      <header className="mb-5">
        <h2 className="text-2xl font-black tracking-tight text-zinc-900">Create product from link</h2>
        <p className="mt-1 text-sm text-zinc-600">
          Paste a product link, set your rental prices, and review the draft before anything goes live.
        </p>
      </header>

      {providers && !providers.image.real ? (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-semibold">Development fixture mode</p>
          <p className="mt-1">
            No image provider is configured, so placeholder images will be produced. They cannot be published.
          </p>
        </div>
      ) : null}

      <div className="space-y-4">
        <label className="block">
          <span className="mb-1 block text-sm font-semibold text-zinc-800">Product URL</span>
          <input
            type="url"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={sourceUrl}
            onChange={(event) => setSourceUrl(event.target.value)}
            placeholder="https://…"
            className="w-full rounded-xl border border-zinc-300 px-4 py-3 text-base"
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-sm font-semibold text-zinc-800">Weekly price (€)</span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={weeklyPrice}
              onChange={(event) => setWeeklyPrice(event.target.value)}
              placeholder="29.00"
              className="w-full rounded-xl border border-zinc-300 px-4 py-3 text-base"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-semibold text-zinc-800">Monthly price (€)</span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={monthlyPrice}
              onChange={(event) => setMonthlyPrice(event.target.value)}
              placeholder="89.00"
              className="w-full rounded-xl border border-zinc-300 px-4 py-3 text-base"
            />
          </label>
        </div>

        <div>
          <span className="mb-1 block text-sm font-semibold text-zinc-800">
            Your photos <span className="font-normal text-zinc-500">— optional, up to 5</span>
          </span>
          <p className="mb-2 text-xs text-zinc-500">
            Your own photos are the most reliable reference for colour and condition.
          </p>

          <div className="flex flex-wrap gap-2">
            {photos.map((photo) => (
              <div key={photo.id} className="relative h-20 w-20 overflow-hidden rounded-lg border border-zinc-300">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photo.url} alt={photo.name} className="h-full w-full object-cover" />
                <button
                  type="button"
                  onClick={() => setPhotos((prev) => prev.filter((entry) => entry.id !== photo.id))}
                  className="absolute right-0 top-0 bg-rose-600/90 px-1.5 text-xs font-bold text-white"
                  aria-label={`Remove ${photo.name}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          {photos.length < 5 ? (
            <div className="mt-2 grid grid-cols-2 gap-2">
              {/* `capture` opens the camera directly on phones; the second input
                  keeps the normal gallery/file picker available everywhere. */}
              <label className="flex cursor-pointer items-center justify-center rounded-xl border border-dashed border-zinc-400 px-3 py-3 text-sm font-semibold text-zinc-700">
                Take photo
                <input type="file" accept="image/*" capture="environment" onChange={onPhotosSelected} className="hidden" />
              </label>
              <label className="flex cursor-pointer items-center justify-center rounded-xl border border-dashed border-zinc-400 px-3 py-3 text-sm font-semibold text-zinc-700">
                Choose photos
                <input type="file" accept="image/*" multiple onChange={onPhotosSelected} className="hidden" />
              </label>
            </div>
          ) : null}
          {uploading ? <p className="mt-2 text-xs font-semibold text-zinc-600">Uploading…</p> : null}
        </div>

        <label className="block">
          <span className="mb-1 block text-sm font-semibold text-zinc-800">
            Instruction <span className="font-normal text-zinc-500">— optional</span>
          </span>
          <textarea
            rows={3}
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder="e.g. This one is black, not silver. Do not include the carrying bag."
            className="w-full rounded-xl border border-zinc-300 px-4 py-3 text-base"
          />
        </label>

        {error ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div>
        ) : null}
        {status && !error ? <p className="text-sm font-semibold text-zinc-600">{status}</p> : null}

        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSubmit}
          className="w-full rounded-xl bg-[rgb(73,153,173)] px-4 py-4 text-base font-bold text-white transition hover:bg-[rgb(60,138,158)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? "Creating draft…" : "Create Draft"}
        </button>

        <p className="text-center text-xs text-zinc-500">
          Drafts are private. Nothing is published until you approve it.
        </p>
      </div>
    </section>
  );
}
