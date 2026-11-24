import type { Product } from "@/lib/types";

export type CardPriceUnit = "week" | "month" | "day";

export type CardPrice = {
  unit: CardPriceUnit;
  /** Price to show (the offer when a genuine offer exists). */
  price: number;
  /** The struck-through base price, only when a genuine offer applies. */
  basePrice: number;
  hasOffer: boolean;
};

const offerApplies = (base: number, offer: number) => base > 0 && offer > 0 && offer < base;

/**
 * The single rental price a product CARD shows. Detail pages keep every option.
 * Owner choice (`cardPriceUnit`) wins when that price exists; otherwise:
 * occasion products show the daily price, everything else the weekly price,
 * unless only a monthly price exists.
 */
export function resolveCardPrice(product: Product): CardPrice {
  const weekly = { base: product.buyerPrice || 0, offer: product.offerPrice || 0 };
  const monthlyBase = product.monthlyBuyerPrice || product.monthlyPrice || 0;
  const monthly = { base: monthlyBase, offer: product.monthlyOfferPrice || 0 };
  const dayRate = product.rentalMode === "occasion" ? [...(product.occasionPricing || [])].sort((a, b) => a.days - b.days)[0]?.price || 0 : 0;

  const has: Record<CardPriceUnit, boolean> = {
    week: weekly.base > 0 || weekly.offer > 0,
    month: monthly.base > 0 || monthly.offer > 0,
    day: dayRate > 0,
  };

  const preferred = product.cardPriceUnit && has[product.cardPriceUnit] ? product.cardPriceUnit : null;
  const unit: CardPriceUnit =
    preferred ?? (product.rentalMode === "occasion" && has.day ? "day" : has.week ? "week" : has.month ? "month" : has.day ? "day" : "week");

  if (unit === "day") return { unit, price: dayRate, basePrice: dayRate, hasOffer: false };
  const rate = unit === "month" ? monthly : weekly;
  const hasOffer = offerApplies(rate.base, rate.offer);
  return { unit, price: hasOffer ? rate.offer : rate.base, basePrice: rate.base, hasOffer };
}
