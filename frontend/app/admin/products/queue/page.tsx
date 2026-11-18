"use client";

import { ChangeEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ProductPackageItem,
  deleteProductPackage,
  fetchProductPackages,
  importProductPackages,
  submitProductPackages,
  uploadProductImage,
} from "@/lib/api";

type PackageImage = { url?: string; file?: string; [key: string]: unknown };
type RawPackage = { images?: PackageImage[]; [key: string]: unknown };

/** Accepts one package, an array of packages, or { packages: [...] }. */
function extractPackages(parsed: unknown): RawPackage[] {
  if (Array.isArray(parsed)) return parsed as RawPackage[];
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { packages?: unknown }).packages)) {
    return (parsed as { packages: RawPackage[] }).packages;
  }
  return parsed && typeof parsed === "object" ? [parsed as RawPackage] : [];
}

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
  const [imageFiles, setImageFiles] = useState<File[]>([]);
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

  const addPackages = async (packages: RawPackage[]) => {
    if (!packages.length) {
      setError("No packages found in that file.");
      return;
    }
    setBusy("Adding to queue...");
    setError("");
    try {
      // Images supplied as files are uploaded first and referenced by URL.
      const byName = new Map(imageFiles.map((file) => [file.name, file]));
      const uploaded = new Map<string, string>();
      for (const pkg of packages) {
        for (const image of pkg.images || []) {
          if (image.url || !image.file) continue;
          const file = byName.get(String(image.file));
          if (!file) continue;
          if (!uploaded.has(file.name)) uploaded.set(file.name, await uploadProductImage(file, token));
          image.url = uploaded.get(file.name);
        }
      }
      const { results } = await submitProductPackages(token, packages);
      const ready = results.filter((r) => r.status === "ready").length;
      const invalid = results.filter((r) => r.status === "invalid").length;
      setMessage(`${ready} ready, ${invalid} need fixes.`);
      await reload(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add packages.");
    } finally {
      setBusy("");
    }
  };

  const onFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    const all: RawPackage[] = [];
    for (const file of files) {
      try {
        all.push(...extractPackages(JSON.parse(await file.text())));
      } catch {
        setError(`${file.name} is not valid JSON.`);
        return;
      }
    }
    await addPackages(all);
  };

  const onPaste = async () => {
    try {
      await addPackages(extractPackages(JSON.parse(pasted)));
      setPasted("");
    } catch {
      setError("The pasted text is not valid JSON.");
    }
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
        <label className="block text-sm font-semibold text-zinc-700">
          Package files (.json)
          <input type="file" accept="application/json,.json" multiple disabled={Boolean(busy)} onChange={onFiles} className="mt-1 block w-full text-sm" />
        </label>
        <label className="block text-sm font-semibold text-zinc-700">
          Image files named in the packages (optional)
          <input
            type="file" accept="image/*" multiple
            onChange={(event) => setImageFiles(Array.from(event.target.files || []))}
            className="mt-1 block w-full text-sm"
          />
          <span className="text-xs font-normal text-zinc-500">{imageFiles.length} selected. Choose these before the package files.</span>
        </label>
        <details>
          <summary className="cursor-pointer text-sm font-semibold text-zinc-700">Or paste package JSON</summary>
          <textarea value={pasted} onChange={(e) => setPasted(e.target.value)} rows={6} className="mt-2 w-full rounded-lg border border-zinc-300 p-2 font-mono text-xs" />
          <button type="button" disabled={!pasted.trim() || Boolean(busy)} onClick={() => void onPaste()} className="mt-2 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-semibold disabled:opacity-50">
            Add pasted package
          </button>
        </details>
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
