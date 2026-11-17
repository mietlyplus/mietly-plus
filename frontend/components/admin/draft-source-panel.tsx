"use client";

import { ChangeEvent, useState } from "react";
import { resumeProductDraft, uploadProductImage } from "@/lib/api";
import { ProductDraft } from "@/lib/types";

type Props = {
  token: string;
  draft: ProductDraft;
  onDraft: (next: ProductDraft) => void;
  onMessage: (message: string) => void;
  onError: (message: string) => void;
};

/**
 * Continue the SAME draft with better source material: an alternate link,
 * details pasted from a spec sheet, and/or reference photos. Prices and existing
 * photos are kept; a source that already worked is reused.
 */
export function DraftSourcePanel({ token, draft, onDraft, onMessage, onError }: Props) {
  const [sourceUrl, setSourceUrl] = useState("");
  const [details, setDetails] = useState(draft.pastedDetails || "");
  const [photos, setPhotos] = useState<string[]>([]);
  const [busy, setBusy] = useState("");

  const needsSource = draft.status === "needs_source";
  const hasInput = sourceUrl.trim() !== "" || details.trim() !== (draft.pastedDetails || "") || photos.length > 0;

  const onPhotos = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (!files.length) return;
    setBusy("upload");
    try {
      const urls: string[] = [];
      for (const file of files.slice(0, 5)) urls.push(await uploadProductImage(file, token));
      setPhotos((prev) => [...prev, ...urls].slice(0, 5));
    } catch (err) {
      onError(err instanceof Error ? err.message : "Photo upload failed.");
    } finally {
      setBusy("");
    }
  };

  const onContinue = async () => {
    setBusy("continue");
    onError("");
    try {
      const next = await resumeProductDraft(token, draft.id, {
        ...(sourceUrl.trim() ? { sourceUrl: sourceUrl.trim() } : {}),
        ...(details.trim() !== (draft.pastedDetails || "") ? { details: details.trim() } : {}),
        ...(photos.length ? { imageUrls: photos } : {}),
      });
      onDraft(next);
      setSourceUrl("");
      setPhotos([]);
      onMessage(next.status === "needs_source" ? "Still no usable source information." : "Draft updated.");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not continue the draft.");
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
      <p className="font-semibold">
        {needsSource ? "Needs source information" : "Add reference photos or more source material"}
      </p>
      <p className="mt-1">
        {needsSource
          ? "The product page could not be read, so nothing was written from it. Your prices, notes and photos are saved. Give another link, paste the product details, or add photos — then continue on this same draft."
          : "More reference material lets the missing images be created. Everything already on the draft is kept."}
      </p>

      <label className="mt-3 block">
        <span className="mb-1 block font-semibold">Another product link (e.g. the manufacturer&apos;s page)</span>
        <input
          type="url"
          value={sourceUrl}
          onChange={(event) => setSourceUrl(event.target.value)}
          placeholder={draft.sourceUrl || "https://…"}
          className="w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-base text-zinc-900"
        />
      </label>

      <label className="mt-3 block">
        <span className="mb-1 block font-semibold">Or paste the product details</span>
        <textarea
          rows={5}
          value={details}
          onChange={(event) => setDetails(event.target.value)}
          placeholder="Name, model, key specifications — only facts you are sure of."
          className="w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-base text-zinc-900"
        />
      </label>

      <div className="mt-3">
        <span className="mb-1 block font-semibold">Reference photos of the product</span>
        <div className="flex flex-wrap items-center gap-2">
          <label className="cursor-pointer rounded-lg border border-amber-400 bg-white px-3 py-2 font-semibold">
            Choose photos
            <input type="file" accept="image/*" multiple onChange={onPhotos} className="hidden" />
          </label>
          <label className="cursor-pointer rounded-lg border border-amber-400 bg-white px-3 py-2 font-semibold">
            Take photo
            <input type="file" accept="image/*" capture="environment" onChange={onPhotos} className="hidden" />
          </label>
          {photos.length > 0 ? <span>{photos.length} ready to add</span> : null}
          {busy === "upload" ? <span>Uploading…</span> : null}
        </div>
      </div>

      <button
        type="button"
        onClick={onContinue}
        disabled={Boolean(busy) || !hasInput}
        className="mt-4 rounded-lg bg-[rgb(73,153,173)] px-4 py-2.5 font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy === "continue" ? "Continuing…" : "Continue this draft"}
      </button>
    </div>
  );
}
