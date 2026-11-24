"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { bulkDeleteProducts, deleteProduct, fetchAdminProducts } from "@/lib/api";
import { Product } from "@/lib/types";

// Mirrors the server's pricing rule (backend/lib/pricing.js): an offer only
// applies when it is above 0 and below the normal rate. An unset offer (0) means
// "no offer", not "drops to EUR 0", so it must not be drawn as a price change.
function formatRate(rate?: number, offer?: number) {
  const base = Number(rate) || 0;
  const off = Number(offer) || 0;
  if (base <= 0) return "not offered";
  if (off > 0 && off < base) return `EUR ${base} → EUR ${off}`;
  return `EUR ${base}`;
}

export default function AdminProductsListPage() {
  const [adminToken] = useState(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem("admin_token") || "";
  });
  const [products, setProducts] = useState<Product[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string[]>([]);

  const loadProducts = async (token: string) => {
    const data = await fetchAdminProducts(token);
    setProducts(data);
    setSelected((current) => current.filter((id) => data.some((product) => product.id === id)));
  };

  const allSelected = products.length > 0 && selected.length === products.length;

  const onBulkDelete = async () => {
    if (!adminToken || selected.length === 0) return;
    const names = products.filter((product) => selected.includes(product.id)).slice(0, 5).map((product) => product.title);
    const more = selected.length > names.length ? `\n...and ${selected.length - names.length} more` : "";
    if (!window.confirm(`Permanently delete ${selected.length} selected product(s) and their drafts?\n\n${names.join("\n")}${more}\n\nCategories, brands, orders and images are not affected. This cannot be undone.`)) return;
    setMessage("");
    setError("");
    try {
      const result = await bulkDeleteProducts(adminToken, selected);
      setMessage(`Deleted ${result.deletedProducts} product(s) and ${result.deletedDrafts} draft(s).`);
      setSelected([]);
      await loadProducts(adminToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the selected products.");
    }
  };

  useEffect(() => {
    if (!adminToken) return;
    fetchAdminProducts(adminToken)
      .then((data) => setProducts(data))
      .catch(() => setError("Could not fetch products."));
  }, [adminToken]);

  const onDelete = async (productId: string) => {
    if (!adminToken) return;
    if (!window.confirm("Delete this product?")) return;
    setMessage("");
    setError("");
    try {
      await deleteProduct(adminToken, productId);
      setMessage("Product deleted.");
      await loadProducts(adminToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete product.");
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-zinc-900">Product List</h1>
        <div className="flex gap-2">
          <Link href="/admin/products" className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700">
            Add Product
          </Link>
          <Link href="/admin/products/bulk" className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700">
            Add Bulk
          </Link>
        </div>
      </div>

      {message ? <p className="text-sm text-lime-700">{message}</p> : null}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        {products.length > 0 ? (
          <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-2 font-medium text-zinc-700">
              <input type="checkbox" className="h-4 w-4" checked={allSelected} onChange={(e) => setSelected(e.target.checked ? products.map((product) => product.id) : [])} />
              Select all ({products.length})
            </label>
            <button
              type="button"
              disabled={selected.length === 0}
              onClick={() => void onBulkDelete()}
              className="rounded-lg border border-red-200 px-3 py-1.5 font-medium text-red-600 hover:bg-red-50 disabled:opacity-40"
            >
              Delete selected ({selected.length})
            </button>
          </div>
        ) : null}
        <div className="space-y-3">
          {products.length === 0 ? <p className="text-sm text-zinc-500">No products yet.</p> : null}
          {products.map((product) => (
            <div key={product.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-200 p-3">
              <input
                type="checkbox" className="h-4 w-4" aria-label={`Select ${product.title}`}
                checked={selected.includes(product.id)}
                onChange={(e) => setSelected((current) => (e.target.checked ? [...current, product.id] : current.filter((id) => id !== product.id)))}
              />
              <img src={product.imageUrl} alt={product.title} className="h-14 w-24 rounded object-cover" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate font-semibold text-zinc-900">{product.title}</p>
                  {product.isMostPopular ? (
                    <span className="rounded-full bg-lime-100 px-2 py-0.5 text-[11px] font-semibold text-lime-700">
                      Most Popular
                    </span>
                  ) : null}
                </div>
                <p className="truncate text-xs text-zinc-500">{product.category?.name.en || "Uncategorized"}</p>
                <p className="text-xs text-zinc-500">
                  EUR {product.monthlyPrice}/month | Weekly: {formatRate(product.buyerPrice, product.offerPrice)} | Monthly: {formatRate(product.monthlyBuyerPrice, product.monthlyOfferPrice)} | {product.minimumRentalWeeks}-{product.maximumRentalWeeks} weeks | {product.minimumRentalMonths}-{product.maximumRentalMonths} months | stock {product.stock} ({product.stockStatus.replace("_", " ")})
                </p>
                <p className="text-xs text-zinc-500">
                  Deposit EUR {product.securityDeposit} | {product.refundable ? "refundable" : "non-refundable"} | {product.isActive ? "active" : "inactive"}
                </p>
                <p className="text-xs text-zinc-500">
                  Verification: {product.verificationRequired ? "required" : "not required"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => (window.location.href = `/admin/products/edit/${product.id}`)}
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => onDelete(product.id)}
                className="rounded-lg border border-red-200 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50"
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
