"use client";

import { CartItem } from "@/lib/types";

const CART_STORAGE_KEY = "leihfluss_cart";
const CART_CHANGE_EVENT = "leihfluss-cart-change";

function readCartUnsafe(): CartItem[] {
  if (typeof window === "undefined") return [];
  const raw = localStorage.getItem(CART_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as CartItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeCartUnsafe(items: CartItem[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(items));
  window.dispatchEvent(new CustomEvent(CART_CHANGE_EVENT));
}

export function getCartItems() {
  return readCartUnsafe();
}

/** The cap the storefront can enforce locally. `maxRentalQuantity` is a snapshot
 *  taken at add-to-cart time, so it can be missing (older carts) or stale; the
 *  server quote is what finally decides. Missing means "unknown", not "1", so a
 *  cart saved before this field existed is never silently clamped. */
export function getCartItemMaxQuantity(item: Pick<CartItem, "maxRentalQuantity">) {
  const max = Number(item.maxRentalQuantity);
  if (!Number.isFinite(max) || max < 1) return null;
  return Math.floor(max);
}

function clampQuantity(quantity: number, maxQuantity: number | null) {
  const parsed = Math.floor(Number(quantity));
  // A cleared number input yields NaN; fall back to 1 rather than storing it.
  const floor = Number.isFinite(parsed) ? Math.max(1, parsed) : 1;
  if (maxQuantity === null) return floor;
  return Math.min(floor, maxQuantity);
}

export function getCartCount() {
  return readCartUnsafe().reduce((sum, item) => sum + Math.max(1, item.quantity || 1), 0);
}

export function addCartItem(item: Omit<CartItem, "id" | "addedAt">) {
  const items = readCartUnsafe();
  const existingIndex = items.findIndex(
    (entry) =>
      entry.productId === item.productId &&
      entry.durationValue === item.durationValue &&
      entry.durationUnit === item.durationUnit &&
      entry.startDate === item.startDate
  );

  if (existingIndex >= 0) {
    const merged = { ...items[existingIndex], ...item };
    items[existingIndex] = {
      ...merged,
      quantity: clampQuantity(
        items[existingIndex].quantity + Math.max(1, item.quantity || 1),
        getCartItemMaxQuantity(merged)
      ),
    };
  } else {
    items.push({
      ...item,
      quantity: clampQuantity(item.quantity || 1, getCartItemMaxQuantity(item)),
      id: `${item.productId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      addedAt: new Date().toISOString(),
    });
  }

  writeCartUnsafe(items);
}

export function removeCartItem(itemId: string) {
  const items = readCartUnsafe().filter((item) => item.id !== itemId);
  writeCartUnsafe(items);
}

export function updateCartItemQuantity(itemId: string, quantity: number) {
  const items = readCartUnsafe().map((item) =>
    item.id === itemId
      ? { ...item, quantity: clampQuantity(quantity, getCartItemMaxQuantity(item)) }
      : item
  );
  writeCartUnsafe(items);
}

/** Applies the server's authoritative limits to the stored cart, clamping any
 *  quantity that exceeds the current cap. Returns true if anything changed. */
export function applyCartLimits(limitsByLineId: Record<string, number>) {
  const items = readCartUnsafe();
  let changed = false;

  const next = items.map((item) => {
    const maxQuantity = limitsByLineId[item.id];
    if (!Number.isFinite(maxQuantity) || maxQuantity < 1) return item;

    const clamped = Math.min(Math.max(1, Math.floor(item.quantity)), Math.floor(maxQuantity));
    if (clamped === item.quantity && item.maxRentalQuantity === maxQuantity) return item;

    changed = true;
    return { ...item, quantity: clamped, maxRentalQuantity: Math.floor(maxQuantity) };
  });

  if (changed) writeCartUnsafe(next);
  return changed;
}

export function clearCart() {
  writeCartUnsafe([]);
}

export function subscribeCartChange(callback: () => void) {
  if (typeof window === "undefined") return () => {};
  const handler = () => callback();
  window.addEventListener(CART_CHANGE_EVENT, handler);
  return () => window.removeEventListener(CART_CHANGE_EVENT, handler);
}
