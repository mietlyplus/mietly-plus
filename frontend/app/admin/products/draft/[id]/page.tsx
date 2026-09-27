"use client";

import { ChangeEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  discardProductDraft,
  fetchProductDraft,
  generateDraftImage,
  publishProductDraft,
  regenerateDraftText,
  updateDraftImages,
  uploadProductImage,
} from "@/lib/api";
import { ProductDraft } from "@/lib/types";

function Warning({ code, message }: { code: string; message: string }) {
  const severe = /unresolved|failed|insufficient|fixture/.test(code);
  return (
    <li className={severe ? "text-rose-800" : "text-amber-900"}>
      <span className="font-semibold">{code}</span> — {message}
    </li>
  );
}

export default function ProductDraftReviewPage() {
  const router = useRouter();
  const params = useParams();
  const draftId = Array.isArray(params?.id) ? String(params.id[0]) : String(params?.id || "");

  const [token, setToken] = useState("");
  const [draft, setDraft] = useState<ProductDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    setToken(localStorage.getItem("admin_token") || "");
  }, []);

  const load = useCallback(
    async (adminToken: string) => {
      try {
        setDraft(await fetchProductDraft(adminToken, draftId));
        setError("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load the draft.");
      } finally {
        setLoading(false);
      }
    },
    [draftId]
  );

  useEffect(() => {
    if (!token || !draftId) return;
    load(token);
  }, [token, draftId, load]);

  const run = async (label: string, action: () => Promise<ProductDraft | void>) => {
    setBusy(label);
    setError("");
    setMessage("");
    try {
      const next = await action();
      if (next) setDraft(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That action failed.");
    } finally {
      setBusy("");
    }
  };

  const onUploadReplacement = async (event: ChangeEvent<HTMLInputElement>, imageId: string) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !token) return;
    await run("upload", async () => {
      const url = await uploadProductImage(file, token);
      return updateDraftImages(token, draftId, { action: "replace", imageId, url });
    });
  };

  const onAddPhoto = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !token) return;
    await run("upload", async () => {
      const url = await uploadProductImage(file, token);
      return updateDraftImages(token, draftId, { action: "add", url });
    });
  };

  const onPublish = async () => {
    if (!token) return;
    if (!window.confirm("Publish this product to the live Leihfluss catalogue?")) return;
    await run("publish", async () => {
      const result = await publishProductDraft(token, draftId);
      setMessage(result.message);
      return result.draft;
    });
  };

  const onDiscard = async () => {
    if (!token) return;
    if (!window.confirm("Delete this draft and its private product?")) return;
    await run("discard", async () => {
      await discardProductDraft(token, draftId);
      router.push("/admin/products/list");
    });
  };

  if (!token) return <p className="text-sm text-zinc-600">Admin token missing. Please sign in again.</p>;
  if (loading) return <p className="text-sm text-zinc-600">Loading draft…</p>;
  if (!draft) return <p className="text-sm text-rose-700">{error || "Draft not found."}</p>;

  const product = draft.product;
  const fixtureImages = draft.images.filter((image) => image.isFixture);
  const published = draft.status === "published";

  return (
    <section className="mx-auto w-full max-w-3xl space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-black tracking-tight text-zinc-900">Review draft</h2>
          <p className="mt-1 text-sm text-zinc-600">
            Status: <span className="font-semibold">{draft.status}</span>
            {published ? " — live on the storefront" : " — private, not visible to customers"}
          </p>
        </div>
        {product ? (
          <Link
            href={`/admin/products/edit/${product.id}`}
            className="rounded-lg border border-zinc-300 px-3 py-2 text-sm font-semibold text-zinc-800"
          >
            Open full editor
          </Link>
        ) : null}
      </header>

      <div className="rounded-xl border border-zinc-200 bg-white p-4 text-sm">
        <h3 className="font-bold text-zinc-900">Provenance</h3>
        <dl className="mt-2 grid gap-1 sm:grid-cols-2">
          <div><dt className="inline text-zinc-500">Source: </dt>
            <dd className="inline break-all">{draft.sourceUrl || "—"}</dd></div>
          <div><dt className="inline text-zinc-500">Extraction: </dt>
            <dd className="inline">{draft.provenance.extractionConfidence || "—"} ({draft.provenance.usedStrategies.join(", ") || "none"})</dd></div>
          <div><dt className="inline text-zinc-500">Weekly rent: </dt>
            <dd className="inline font-semibold">€{draft.weeklyPrice.toFixed(2)}</dd></div>
          <div><dt className="inline text-zinc-500">Monthly rent: </dt>
            <dd className="inline font-semibold">€{draft.monthlyPrice.toFixed(2)}</dd></div>
          <div className="sm:col-span-2">
            <dt className="inline text-zinc-500">Text provider: </dt>
            <dd className="inline">{draft.providers.text.id} ({draft.providers.text.real ? "real" : "FIXTURE"})</dd>
            <dt className="ml-3 inline text-zinc-500">Images: </dt>
            <dd className="inline">{draft.providers.image.id} ({draft.providers.image.real ? "real" : "FIXTURE"})</dd>
          </div>
          {draft.provenance.retailerPrice?.amount ? (
            <div className="sm:col-span-2 text-zinc-500">
              Retailer price seen on the source page: {draft.provenance.retailerPrice.amount}{" "}
              {draft.provenance.retailerPrice.currency} — reference only, never used for rent.
            </div>
          ) : null}
        </dl>
      </div>

      {draft.warnings.length > 0 ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
          <h3 className="text-sm font-bold text-amber-900">Review these before publishing</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
            {draft.warnings.map((warning, index) => (
              <Warning key={`${warning.code}-${index}`} code={warning.code} message={warning.message} />
            ))}
          </ul>
        </div>
      ) : null}

      <div className="rounded-xl border border-zinc-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-bold text-zinc-900">Images ({draft.images.length}/5)</h3>
          {draft.images.length < 5 ? (
            <label className="cursor-pointer rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-semibold">
              Add photo
              <input type="file" accept="image/*" onChange={onAddPhoto} className="hidden" />
            </label>
          ) : null}
        </div>

        <ul className="mt-3 space-y-3">
          {draft.images.map((image, index) => (
            <li key={image.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 p-2">
              <div className="h-20 w-20 shrink-0 overflow-hidden rounded-md border border-zinc-200 bg-zinc-50">
                {image.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={image.url} alt={image.role} className="h-full w-full object-cover" />
                ) : (
                  <span className="flex h-full w-full items-center justify-center text-[10px] text-zinc-400">
                    {image.status}
                  </span>
                )}
              </div>

              <div className="min-w-[8rem] flex-1 text-xs">
                <p className="font-semibold text-zinc-800">
                  {index === 0 ? "Primary · " : ""}{image.role || "image"}
                </p>
                <p className="text-zinc-500">
                  {image.origin}
                  {image.isFixture ? " · DEV FIXTURE" : ""}
                  {image.status === "failed" ? ` · ${image.error}` : ""}
                </p>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {index !== 0 ? (
                  <button type="button" disabled={Boolean(busy)}
                    onClick={() => run("primary", () => updateDraftImages(token, draftId, { action: "primary", imageId: image.id }))}
                    className="rounded border border-zinc-300 px-2 py-1 text-xs font-semibold">Make primary</button>
                ) : null}
                {index > 0 ? (
                  <button type="button" disabled={Boolean(busy)}
                    onClick={() => {
                      const ids = draft.images.map((entry) => entry.id);
                      [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]];
                      return run("reorder", () => updateDraftImages(token, draftId, { action: "reorder", imageIds: ids }));
                    }}
                    className="rounded border border-zinc-300 px-2 py-1 text-xs font-semibold">↑</button>
                ) : null}
                {index < draft.images.length - 1 ? (
                  <button type="button" disabled={Boolean(busy)}
                    onClick={() => {
                      const ids = draft.images.map((entry) => entry.id);
                      [ids[index], ids[index + 1]] = [ids[index + 1], ids[index]];
                      return run("reorder", () => updateDraftImages(token, draftId, { action: "reorder", imageIds: ids }));
                    }}
                    className="rounded border border-zinc-300 px-2 py-1 text-xs font-semibold">↓</button>
                ) : null}
                {image.origin !== "user" ? (
                  <button type="button" disabled={Boolean(busy)}
                    onClick={() => run(`image-${image.id}`, () => generateDraftImage(token, draftId, image.id))}
                    className="rounded border border-[rgba(73,153,173,0.5)] px-2 py-1 text-xs font-semibold text-[rgb(47,118,135)]">
                    {busy === `image-${image.id}` ? "Generating…" : "Regenerate"}
                  </button>
                ) : null}
                <label className="cursor-pointer rounded border border-zinc-300 px-2 py-1 text-xs font-semibold">
                  Replace
                  <input type="file" accept="image/*" onChange={(event) => onUploadReplacement(event, image.id)} className="hidden" />
                </label>
                <button type="button" disabled={Boolean(busy)}
                  onClick={() => run("delete", () => updateDraftImages(token, draftId, { action: "delete", imageId: image.id }))}
                  className="rounded border border-rose-300 px-2 py-1 text-xs font-semibold text-rose-700">Delete</button>
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-zinc-500">
          Regenerating one image leaves the listing text and the other images untouched.
        </p>
      </div>

      {product ? (
        <div className="rounded-xl border border-zinc-200 bg-white p-4 text-sm">
          <h3 className="font-bold text-zinc-900">Generated listing</h3>
          <dl className="mt-2 space-y-2">
            <div><dt className="text-zinc-500">Title (DE)</dt><dd className="font-semibold">{product.titleI18n?.de || product.title}</dd></div>
            <div><dt className="text-zinc-500">Title (EN)</dt><dd>{product.titleI18n?.en || "—"}</dd></div>
            <div><dt className="text-zinc-500">Category</dt><dd>{product.category?.name?.en || "—"}</dd></div>
            <div><dt className="text-zinc-500">Brand</dt><dd>{product.brand || "—"}</dd></div>
            <div><dt className="text-zinc-500">Slug</dt><dd className="font-mono text-xs">{product.slug}</dd></div>
            <div><dt className="text-zinc-500">Short description</dt><dd>{product.shortDescription || "—"}</dd></div>
            <div><dt className="text-zinc-500">Specifications</dt>
              <dd>{product.specifications?.length ? product.specifications.map((s) => `${s.key}: ${s.value}`).join(" · ") : "—"}</dd></div>
            <div><dt className="text-zinc-500">SEO title</dt><dd>{product.seo?.metaTitle || "—"}</dd></div>
          </dl>
          <p className="mt-3 text-xs text-zinc-500">Every field is editable in the full editor.</p>
        </div>
      ) : null}

      {error ? <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div> : null}
      {message ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{message}</div> : null}

      {fixtureImages.length > 0 ? (
        <div className="rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900">
          This draft contains development fixture images. Publishing is blocked until they are replaced.
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={Boolean(busy) || published}
          onClick={() => run("text", () => regenerateDraftText(token, draftId, draft.instruction))}
          className="rounded-lg border border-zinc-300 px-4 py-2.5 text-sm font-semibold">
          {busy === "text" ? "Regenerating…" : "Regenerate text"}
        </button>
        <button type="button" disabled={Boolean(busy) || published || fixtureImages.length > 0}
          onClick={onPublish}
          className="rounded-lg bg-[rgb(73,153,173)] px-4 py-2.5 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50">
          {busy === "publish" ? "Publishing…" : published ? "Published" : "Approve & Publish"}
        </button>
        <button type="button" disabled={Boolean(busy)} onClick={onDiscard}
          className="rounded-lg border border-rose-300 px-4 py-2.5 text-sm font-semibold text-rose-700">
          Delete draft
        </button>
      </div>
    </section>
  );
}
