"use client";

import { useCallback, useEffect, useState } from "react";
import { createBrand, createCategory, fetchAdminBrands, fetchAdminCategoryTree, updateDraftTaxonomy } from "@/lib/api";
import { Brand, Category, ProductDraft } from "@/lib/types";

type Props = {
  token: string;
  draft: ProductDraft;
  onDraft: (next: ProductDraft) => void;
  onMessage: (message: string) => void;
  onError: (message: string) => void;
};

function flatten(nodes: Category[], depth = 0): Array<{ id: string; label: string }> {
  return nodes.flatMap((node) => [
    { id: node.id, label: `${"— ".repeat(depth)}${node.name.en || node.name.de}` },
    ...flatten(node.children || [], depth + 1),
  ]);
}

const slugify = (value: string) =>
  value.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * The category and brand are the owner's call. Unmatched values stay unresolved;
 * pick an existing one here, or explicitly add a new one (it asks first).
 */
export function DraftTaxonomyPanel({ token, draft, onDraft, onMessage, onError }: Props) {
  const [categories, setCategories] = useState<Array<{ id: string; label: string }>>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [categoryId, setCategoryId] = useState(draft.product?.categoryId || "");
  const [brandId, setBrandId] = useState(draft.product?.brandId || "");
  const [busy, setBusy] = useState(false);
  const [newCategory, setNewCategory] = useState("");
  const [newBrand, setNewBrand] = useState("");

  const load = useCallback(async () => {
    try {
      const [tree, brandList] = await Promise.all([fetchAdminCategoryTree(token), fetchAdminBrands(token)]);
      setCategories(flatten(tree));
      setBrands(brandList);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not load categories and brands.");
    }
  }, [token, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const current = { category: draft.product?.categoryId || "", brand: draft.product?.brandId || "" };
  const changed = (categoryId && categoryId !== current.category) || (brandId && brandId !== current.brand);

  const save = async () => {
    setBusy(true);
    onError("");
    try {
      const next = await updateDraftTaxonomy(token, draft.id, {
        ...(categoryId && categoryId !== current.category ? { categoryId } : {}),
        ...(brandId && brandId !== current.brand ? { brandId } : {}),
      });
      onDraft(next);
      onMessage("Choice saved.");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not save the choice.");
    } finally {
      setBusy(false);
    }
  };

  const addCategory = async () => {
    const name = newCategory.trim();
    if (!name) return;
    if (!window.confirm(`Add the category "${name}" to your catalogue? It becomes available site-wide.`)) return;
    setBusy(true);
    try {
      const created = await createCategory({ name: { en: name, de: name }, slug: slugify(name) }, token);
      await load();
      setCategoryId(String((created as { id?: string; category?: { id?: string } }).id ?? (created as { category?: { id?: string } }).category?.id ?? ""));
      setNewCategory("");
      onMessage(`Category "${name}" added. Save your choice to use it.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not add the category.");
    } finally {
      setBusy(false);
    }
  };

  const addBrand = async () => {
    const name = newBrand.trim();
    if (!name) return;
    if (!window.confirm(`Add the brand "${name}" to your catalogue? It becomes available site-wide.`)) return;
    setBusy(true);
    try {
      const created = await createBrand(token, { name, slug: slugify(name), isActive: true });
      await load();
      setBrandId(String((created as { id?: string }).id ?? ""));
      setNewBrand("");
      onMessage(`Brand "${name}" added. Save your choice to use it.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not add the brand.");
    } finally {
      setBusy(false);
    }
  };

  const unresolved = draft.needs.taxonomy;

  return (
    <div className={`rounded-xl border p-4 text-sm ${unresolved ? "border-amber-300 bg-amber-50 text-amber-900" : "border-zinc-200 bg-white text-zinc-800"}`}>
      <p className="font-semibold">{unresolved ? "Choose a category and brand — required before publishing" : "Category and brand"}</p>
      {unresolved ? (
        <p className="mt-1">No existing category or brand matched this product. Nothing was substituted — pick one, or add a new one.</p>
      ) : null}

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block font-semibold">Category</span>
          <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}
            className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-base text-zinc-900">
            <option value="">— not chosen —</option>
            {categories.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </select>
          <span className="mt-2 flex gap-2">
            <input value={newCategory} onChange={(event) => setNewCategory(event.target.value)} placeholder="New category name"
              className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-zinc-900" />
            <button type="button" onClick={addCategory} disabled={busy || !newCategory.trim()}
              className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 font-semibold disabled:opacity-50">Add</button>
          </span>
        </label>

        <label className="block">
          <span className="mb-1 block font-semibold">Brand</span>
          <select value={brandId} onChange={(event) => setBrandId(event.target.value)}
            className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-base text-zinc-900">
            <option value="">— not chosen —</option>
            {brands.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
          <span className="mt-2 flex gap-2">
            <input value={newBrand} onChange={(event) => setNewBrand(event.target.value)} placeholder="New brand name"
              className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-zinc-900" />
            <button type="button" onClick={addBrand} disabled={busy || !newBrand.trim()}
              className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 font-semibold disabled:opacity-50">Add</button>
          </span>
        </label>
      </div>

      <button type="button" onClick={save} disabled={busy || !changed}
        className="mt-3 rounded-lg bg-[rgb(73,153,173)] px-4 py-2 font-bold text-white disabled:cursor-not-allowed disabled:opacity-50">
        {busy ? "Saving…" : "Save choice"}
      </button>
    </div>
  );
}
