import test from "node:test";
import assert from "node:assert/strict";
import { resolveCardPrice } from "./card-price.ts";

const p = (over: Record<string, unknown>) => ({ buyerPrice: 0, offerPrice: 0, monthlyBuyerPrice: 0, monthlyOfferPrice: 0, monthlyPrice: 0, rentalMode: "standard", occasionPricing: [], cardPriceUnit: "", ...over }) as never;

test("owner choice wins; old products fall back sensibly", () => {
  const both = { buyerPrice: 15, monthlyBuyerPrice: 40, monthlyPrice: 40 };
  assert.deepEqual(resolveCardPrice(p({ ...both, cardPriceUnit: "month" })).unit, "month");
  assert.equal(resolveCardPrice(p({ ...both, cardPriceUnit: "month" })).price, 40);
  assert.equal(resolveCardPrice(p(both)).unit, "week", "no choice: weekly");
  assert.equal(resolveCardPrice(p({ monthlyBuyerPrice: 40, monthlyPrice: 40 })).unit, "month", "only monthly exists");
  const occ = { rentalMode: "occasion", occasionPricing: [{ days: 2, price: 100 }, { days: 1, price: 50 }] };
  assert.deepEqual([resolveCardPrice(p(occ)).unit, resolveCardPrice(p(occ)).price], ["day", 50]);
  assert.equal(resolveCardPrice(p({ ...both, cardPriceUnit: "day" })).unit, "week", "a unit with no price is not shown");
  const offer = resolveCardPrice(p({ buyerPrice: 20, offerPrice: 15 }));
  assert.deepEqual([offer.price, offer.basePrice, offer.hasOffer], [15, 20, true]);
});
