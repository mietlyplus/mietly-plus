"use client";

import { ChangeEvent, DragEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ProductPackageItem,
  deleteProductPackage,
  fetchProductPackages,
  importProductPackages,
  submitProductPackages,
  uploadProductImage,
} from "@/lib/api";
import { UploadPlan, attachUploadedImages, planPackageFiles } from "@/lib/package-files";

const STATUS_STYLE: Record<ProductPackageItem["status"], string> = {
  ready: "border-emerald-300 bg-emerald-50 text-emerald-800",
  invalid: "border-rose-300 bg-rose-50 text-rose-800",
  imported: "border-zinc-300 bg-zinc-50 text-zinc-700",
};

export default function ProductQueuePage() {
  const [token, setToken] = useState("");
  const [items, setItems] = useState<ProductPackageItem[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [pasted, setPasted] = useState("");
  const [jsonFiles, setJsonFiles] = useState<{ name: string; text: string }[]>([]);
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const reload = useCallback(async (adminToken: string) => {
    const result = await fetchProductPackages(adminToken);
    setItems(result.items);
    setSelected((current) => current.filter((id) => result.items.some((item) => item.id === id && item.status === "ready")));
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem("admin_token") || "";
    setToken(stored);
    if (stored) reload(stored).catch((err) => setError(err instanceof Error ? err.message : "Could not load the queue."));
  }, [reload]);

  // One drop zone: JSON packages and the images they name, matched by filename.
  const plan: UploadPlan = planPackageFiles(jsonFiles, imageFiles.map((file) => file.name));
  const readyPlans = plan.plans.filter((item) => item.status === "READY");

  const takeFiles = async (incoming: File[]) => {
    setError("");
    setMessage("");
    const json = incoming.filter((file) => /\.json$/i.test(file.name) || file.type === "application/json");
    const images = incoming.filter((file) => file.type.startsWith("image/"));
    const texts = await Promise.all(json.map(async (file) => ({ name: file.name, text: await file.text() })));
    setJsonFiles((current) => [...current.filter((c) => !texts.some((t) => t.name === c.name)), ...texts]);
    setImageFiles((current) => [...current.filter((c) => !images.some((i) => i.name === c.name)), ...images]);
    if (json.length + images.length < incoming.length) setError("Some files were ignored: only .json and image files are accepted.");
  };

  const onFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    await takeFiles(files);
  };

  const onDrop = async (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    await takeFiles(Array.from(event.dataTransfer.files));
  };

  const clearSelection = () => { setJsonFiles([]); setImageFiles([]); };

  const addToQueue = async () => {
    setBusy("Uploading images and adding to queue...");
    setError("");
    try {
      const packages = await attachUploadedImages(plan, new Map(imageFiles.map((file) => [file.name, file])), (file) => uploadProductImage(file, token));
      const { results } = await submitProductPackages(token, packages);
      const ready = results.filter((r) => r.status === "ready").length;
      const invalid = results.filter((r) => r.status === "invalid");
      setMessage(`${ready} added and ready.${invalid.length ? ` ${invalid.length} need fixes in the queue below.` : ""}`);
      clearSelection();
      await reload(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add packages.");
    } finally {
      setBusy("");
    }
  };

  const onPaste = () => {
    setJsonFiles((current) => [...current.filter((c) => c.name !== "pasted.json"), { name: "pasted.json", text: pasted }]);
    setPasted("");
  };

  const runImport = async (body: { ids?: string[]; allReady?: boolean }) => {
    setBusy("Importing as private drafts...");
    setError("");
    try {
      let importedCount = 0;
      const failures: string[] = [];
      // The server stops before its time limit and reports what is left.
      for (let round = 0; round < 20; round += 1) {
        const result = await importProductPackages(token, body);
        importedCount += result.imported.length;
        result.failed.forEach((f) => failures.push(`${f.externalId}: ${f.message}`));
        if (result.remaining === 0 || result.imported.length + result.failed.length === 0) break;
      }
      setMessage(`${importedCount} imported as private drafts.${failures.length ? ` ${failures.length} failed.` : ""}`);
      if (failures.length) setError(failures.join(" "));
      setSelected([]);
      await reload(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setBusy("");
    }
  };

  const onRemove = async (id: string) => {
    if (!window.confirm("Remove this package from the queue?")) return;
    try {
      await deleteProductPackage(token, id);
      await reload(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove.");
    }
  };

  if (!token) return <p className="text-sm text-zinc-600">Admin token missing. Please sign in again.</p>;

  const ready = items.filter((item) => item.status === "ready");

  return (
    <section className="mx-auto w-full max-w-3xl">
      <header className="mb-5">
        <h2 className="text-2xl font-black tracking-tight text-zinc-900">AI Product Queue</h2>
        <p className="mt-1 text-sm text-zinc-600">
          Add product packages prepared by ChatGPT Work. Importing creates private drafts only; nothing goes live until you review and publish.
        </p>
      </header>

      <div className="space-y-3 rounded-xl border border-zinc-200 bg-white p-4">
        <label
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => void onDrop(event)}
          className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-8 text-center text-sm ${dragging ? "border-[rgb(73,153,173)] bg-[rgba(73,153,173,0.08)]" : "border-zinc-300"}`}
        >
          <span className="font-semibold text-zinc-800">Drop product JSON files and their images here, or click to choose</span>
          <span className="mt-1 text-xs text-zinc-500">e.g. battlefield.json + battlefield-front.webp + battlefield-back.webp. Images are matched to the JSON by exact filename.</span>
          <input type="file" accept="application/json,.json,image/*" multiple disabled={Boolean(busy)} onChange={onFiles} className="sr-only" />
        </label>
        <details>
          <summary className="cursor-pointer text-sm font-semibold text-zinc-700">Or paste package JSON</summary>
          <textarea value={pasted} onChange={(e) => setPasted(e.target.value)} rows={6} className="mt-2 w-full rounded-lg border border-zinc-300 p-2 font-mono text-xs" />
          <button type="button" disabled={!pasted.trim() || Boolean(busy)} onClick={onPaste} className="mt-2 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-semibold disabled:opacity-50">
            Check pasted package
          </button>
        </details>

        {plan.plans.length > 0 || imageFiles.length > 0 ? (
          <div className="rounded-lg bg-zinc-50 p-3 text-sm">
            <p className="font-semibold text-zinc-800">Selected files ({jsonFiles.length} JSON, {imageFiles.length} image(s))</p>
            <ul className="mt-2 space-y-2">
              {plan.plans.map((item, index) => (
                <li key={`${item.source}-${index}`} className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full border px-2 py-0.5 text-xs font-bold ${item.status === "READY" ? STATUS_STYLE.ready : STATUS_STYLE.invalid}`}>{item.status}</span>
                  <span className="font-semibold text-zinc-900">{item.title}</span>
                  <span className="text-xs text-zinc-500">{item.imageCount} image(s)</span>
                  {item.errors.length ? <span className="w-full text-xs text-rose-700">{item.errors.join(" ")}</span> : null}
                </li>
              ))}
            </ul>
            {plan.unusedImages.length ? (
              <p className="mt-2 text-xs text-amber-800">Unused uploaded images (not referenced by any JSON): {plan.unusedImages.join(", ")}</p>
            ) : null}
            <div className="mt-3 flex gap-2">
              <button type="button" disabled={readyPlans.length === 0 || Boolean(busy)} onClick={() => void addToQueue()} className="rounded-lg bg-[rgb(73,153,173)] px-3 py-1.5 text-sm font-bold text-white disabled:opacity-50">
                Add {readyPlans.length} ready to queue
              </button>
              <button type="button" onClick={clearSelection} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-semibold">Clear</button>
            </div>
          </div>
        ) : null}
      </div>

      {busy ? <p className="mt-3 text-sm text-zinc-600">{busy}</p> : null}
      {message ? <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{message}</p> : null}
      {error ? <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}

      <div className="mt-5 flex flex-wrap gap-2">
        <button
          type="button" disabled={selected.length === 0 || Boolean(busy)} onClick={() => void runImport({ ids: selected })}
          className="rounded-lg bg-[rgb(73,153,173)] px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
        >
          Import selected ({selected.length})
        </button>
        <button
          type="button" disabled={ready.length === 0 || Boolean(busy)}
          onClick={() => void runImport({ allReady: true })}
          className="rounded-lg border border-[rgb(73,153,173)] px-4 py-2 text-sm font-bold text-[rgb(47,118,135)] disabled:opacity-50"
        >
          Import all ready ({ready.length})
        </button>
      </div>

      <ul className="mt-4 space-y-3">
        {items.length === 0 ? <li className="text-sm text-zinc-500">The queue is empty.</li> : null}
        {items.map((item) => (
          <li key={item.id} className="rounded-xl border border-zinc-200 bg-white p-4">
            <div className="flex items-start gap-3">
              {item.status === "ready" ? (
                <input
                  type="checkbox" className="mt-1 h-4 w-4" checked={selected.includes(item.id)} aria-label={`Select ${item.title}`}
                  onChange={(e) => setSelected((cur) => (e.target.checked ? [...cur, item.id] : cur.filter((id) => id !== item.id)))}
                />
              ) : null}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-bold text-zinc-900">{item.title || item.externalId}</p>
                  <span className={`rounded-full border px-2 py-0.5 text-xs font-bold uppercase ${STATUS_STYLE[item.status]}`}>{item.status}</span>
                  {item.rentalMode === "occasion" ? (
                    <span className="rounded-full border border-[rgba(73,153,173,0.35)] bg-[rgba(73,153,173,0.14)] px-2 py-0.5 text-xs font-semibold text-[rgb(47,118,135)]">Occasion</span>
                  ) : null}
                </div>
                <p className="mt-0.5 text-xs text-zinc-500">{item.externalId} · {item.imageCount} image(s)</p>
                {item.errors.length > 0 ? (
                  <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-rose-700">{item.errors.map((e) => <li key={e}>{e}</li>)}</ul>
                ) : null}
                {item.warnings.length > 0 && item.status !== "imported" ? (
                  <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-amber-800">{item.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
                ) : null}
                <div className="mt-2 flex gap-3 text-sm">
                  {item.importedDraftId ? (
                    <Link className="font-semibold text-[rgb(47,118,135)] underline" href={`/admin/products/draft/${item.importedDraftId}`}>Review draft</Link>
                  ) : null}
                  {item.status !== "imported" ? (
                    <button type="button" className="text-rose-700 underline" onClick={() => void onRemove(item.id)}>Remove</button>
                  ) : null}
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
