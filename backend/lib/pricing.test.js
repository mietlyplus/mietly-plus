"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getAvailablePeriodUnits,
  getProductRentalLimits,
  priceOrderItem,
  resolveDurationBounds,
  resolvePeriodUnitPrice,
  sumOrderTotals,
} = require("./pricing");

function buildProduct(overrides = {}) {
  return {
    _id: "6650000000000000000000aa",
    title: "Test Camera",
    slug: "test-camera",
    isActive: true,
    monthlyPrice: 0,
    buyerPrice: 0,
    offerPrice: 0,
    monthlyBuyerPrice: 0,
    monthlyOfferPrice: 0,
    minimumRentalWeeks: 1,
    maximumRentalWeeks: 4,
    minimumRentalMonths: 1,
    maximumRentalMonths: 24,
    minimumRentalDays: 7,
    maximumRentalDays: 30,
    maxRentalQuantity: 1,
    deliveryFee: 0,
    depositEnabled: false,
    securityDeposit: 0,
    verificationRequired: true,
    ...overrides,
  };
}

function priceOk(product, request) {
  const result = priceOrderItem(product, request);
  assert.equal(result.ok, true, result.ok ? "" : `unexpected failure: ${result.error?.message}`);
  return result.item;
}

test("weekly offer price wins when it undercuts the buyer price", () => {
  const product = buildProduct({ buyerPrice: 20, offerPrice: 15 });
  assert.equal(resolvePeriodUnitPrice(product, "week"), 15);

  const item = priceOk(product, { periodUnit: "week", durationValue: 2, quantity: 1 });
  assert.equal(item.baseUnitPrice, 15);
  assert.equal(item.unitPrice, 30);
  assert.equal(item.lineTotal, 30);
});

test("offer price is ignored when it does not undercut the buyer price", () => {
  const product = buildProduct({ buyerPrice: 20, offerPrice: 25 });
  assert.equal(resolvePeriodUnitPrice(product, "week"), 20);
});

test("monthlyPrice remains the legacy fallback for both period units", () => {
  const product = buildProduct({ monthlyPrice: 100 });
  assert.equal(resolvePeriodUnitPrice(product, "month"), 100);
  assert.equal(resolvePeriodUnitPrice(product, "week"), 100);
});

test("monthly ladder is independent of the weekly ladder", () => {
  const product = buildProduct({
    buyerPrice: 20,
    offerPrice: 15,
    monthlyBuyerPrice: 60,
    monthlyOfferPrice: 50,
  });
  assert.equal(resolvePeriodUnitPrice(product, "week"), 15);
  assert.equal(resolvePeriodUnitPrice(product, "month"), 50);
});

test("a weekly-only product cannot be rented by the month", () => {
  const product = buildProduct({ buyerPrice: 20 });
  assert.deepEqual(getAvailablePeriodUnits(product), { week: true, month: false });

  const result = priceOrderItem(product, { periodUnit: "month", durationValue: 1, quantity: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PERIOD_UNIT_UNAVAILABLE");
});

test("a product with no configured price is rejected rather than rented for free", () => {
  const product = buildProduct();
  const result = priceOrderItem(product, { periodUnit: "week", durationValue: 1, quantity: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PRICE_UNAVAILABLE");
});

test("client-supplied amounts cannot influence the charged price", () => {
  const product = buildProduct({
    buyerPrice: 40,
    deliveryFee: 9,
    depositEnabled: true,
    securityDeposit: 150,
  });

  const honest = priceOk(product, { periodUnit: "week", durationValue: 2, quantity: 1 });
  const tampered = priceOk(product, {
    periodUnit: "week",
    durationValue: 2,
    quantity: 1,
    // Every one of these is a field the old endpoint trusted.
    unitPrice: 0.01,
    baseUnitPrice: 0.01,
    securityDeposit: 0,
    deliveryFee: 0,
    lineSubtotal: 0.01,
    lineTotal: 0.01,
    currency: "usd",
  });

  assert.deepEqual(tampered, honest);
  assert.equal(tampered.unitPrice, 80);
  assert.equal(tampered.securityDeposit, 150);
  assert.equal(tampered.deliveryFee, 9);
  assert.equal(tampered.lineTotal, 239);
  assert.equal(tampered.perUnitChargeable, 239);
});

test("deposit is charged only when the product enables it", () => {
  const product = buildProduct({ buyerPrice: 10, depositEnabled: false, securityDeposit: 500 });
  const item = priceOk(product, { periodUnit: "week", durationValue: 1, quantity: 1 });
  assert.equal(item.securityDeposit, 0);
  assert.equal(item.lineDeposit, 0);
});

test("duration below the product minimum is rejected", () => {
  const product = buildProduct({ buyerPrice: 10, minimumRentalWeeks: 2, maximumRentalWeeks: 6 });
  const result = priceOrderItem(product, { periodUnit: "week", durationValue: 1, quantity: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_DURATION");
});

test("duration above the product maximum is rejected", () => {
  const product = buildProduct({ buyerPrice: 10, minimumRentalWeeks: 1, maximumRentalWeeks: 4 });
  const result = priceOrderItem(product, { periodUnit: "week", durationValue: 52, quantity: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_DURATION");
});

test("fractional and non-numeric durations are rejected", () => {
  const product = buildProduct({ buyerPrice: 10, maximumRentalWeeks: 4 });
  for (const durationValue of [1.5, 0, -3, "abc", null, undefined, Infinity]) {
    const result = priceOrderItem(product, { periodUnit: "week", durationValue, quantity: 1 });
    assert.equal(result.ok, false, `expected rejection for durationValue=${String(durationValue)}`);
  }
});

test("weekly duration bounds fall back to the day configuration", () => {
  const product = buildProduct({
    minimumRentalWeeks: undefined,
    maximumRentalWeeks: undefined,
    minimumRentalDays: 14,
    maximumRentalDays: 35,
  });
  assert.deepEqual(resolveDurationBounds(product, "week"), { min: 2, max: 5 });
});

test("quantity above maxRentalQuantity is rejected", () => {
  const product = buildProduct({ buyerPrice: 10, maxRentalQuantity: 2 });
  assert.equal(priceOk(product, { periodUnit: "week", durationValue: 1, quantity: 2 }).quantity, 2);

  const result = priceOrderItem(product, { periodUnit: "week", durationValue: 1, quantity: 3 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_QUANTITY");
});

test("fractional and non-numeric quantities are rejected", () => {
  const product = buildProduct({ buyerPrice: 10, maxRentalQuantity: 5 });
  for (const quantity of [1.5, 0, -2, true, null, undefined, NaN, "two"]) {
    const result = priceOrderItem(product, { periodUnit: "week", durationValue: 1, quantity });
    assert.equal(result.ok, false, `expected rejection for quantity=${String(quantity)}`);
  }

  // A JSON client may legitimately send an integer as a string.
  assert.equal(priceOk(product, { periodUnit: "week", durationValue: 1, quantity: "2" }).quantity, 2);
});

test("inactive products cannot be checked out", () => {
  const product = buildProduct({ buyerPrice: 10, isActive: false });
  const result = priceOrderItem(product, { periodUnit: "week", durationValue: 1, quantity: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PRODUCT_INACTIVE");
});

test("a missing product is rejected", () => {
  const result = priceOrderItem(null, { periodUnit: "week", durationValue: 1, quantity: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PRODUCT_NOT_FOUND");
});

test("unsupported period units are rejected", () => {
  const product = buildProduct({ buyerPrice: 10 });
  for (const periodUnit of ["day", "year", "", null, "WEEKLY"]) {
    const result = priceOrderItem(product, { periodUnit, durationValue: 1, quantity: 1 });
    assert.equal(result.ok, false, `expected rejection for periodUnit=${String(periodUnit)}`);
    assert.equal(result.error.code, "INVALID_PERIOD_UNIT");
  }
});

test("period unit matching is case-insensitive and trimmed", () => {
  const product = buildProduct({ buyerPrice: 10 });
  const item = priceOk(product, { periodUnit: " Week ", durationValue: 1, quantity: 1 });
  assert.equal(item.durationUnit, "week");
});

test("quantity multiplies rent, deposit and delivery consistently", () => {
  const product = buildProduct({
    buyerPrice: 10,
    maxRentalQuantity: 3,
    deliveryFee: 5,
    depositEnabled: true,
    securityDeposit: 20,
  });
  const item = priceOk(product, { periodUnit: "week", durationValue: 2, quantity: 3 });

  assert.equal(item.unitPrice, 20);
  assert.equal(item.lineSubtotal, 60);
  assert.equal(item.lineDeposit, 60);
  assert.equal(item.lineDelivery, 15);
  assert.equal(item.lineTotal, 135);
});

test("totals stay exact at two decimals and match the Stripe cent conversion", () => {
  const product = buildProduct({ buyerPrice: 19.99, deliveryFee: 4.99 });
  const item = priceOk(product, { periodUnit: "week", durationValue: 3, quantity: 1 });

  assert.equal(item.unitPrice, 59.97);
  assert.equal(item.perUnitChargeable, 64.96);
  assert.equal(Math.round(item.perUnitChargeable * 100), 6496);

  const totals = sumOrderTotals([item]);
  assert.equal(totals.subtotal, 59.97);
  assert.equal(totals.deliveryTotal, 4.99);
  assert.equal(totals.total, 64.96);
});

test("order totals sum across multiple lines without float drift", () => {
  const camera = buildProduct({ buyerPrice: 0.1, deliveryFee: 0.2 });
  const tripod = buildProduct({ buyerPrice: 0.1, deliveryFee: 0.1 });

  const totals = sumOrderTotals([
    priceOk(camera, { periodUnit: "week", durationValue: 1, quantity: 1 }),
    priceOk(tripod, { periodUnit: "week", durationValue: 1, quantity: 1 }),
  ]);

  assert.equal(totals.subtotal, 0.2);
  assert.equal(totals.deliveryTotal, 0.3);
  assert.equal(totals.total, 0.5);
});

test("negative product amounts are floored at zero rather than crediting the customer", () => {
  const product = buildProduct({ buyerPrice: 10, deliveryFee: -50 });
  const item = priceOk(product, { periodUnit: "week", durationValue: 1, quantity: 1 });
  assert.equal(item.deliveryFee, 0);
  assert.equal(item.lineTotal, 10);
});

test("verificationRequired is read from the product, not the request", () => {
  const strict = buildProduct({ buyerPrice: 10, verificationRequired: true });
  const relaxed = buildProduct({ buyerPrice: 10, verificationRequired: false });

  assert.equal(
    priceOk(strict, { periodUnit: "week", durationValue: 1, quantity: 1, verificationRequired: false })
      .verificationRequired,
    true
  );
  assert.equal(
    priceOk(relaxed, { periodUnit: "week", durationValue: 1, quantity: 1, verificationRequired: true })
      .verificationRequired,
    false
  );
});

test("rental limits expose the constraints the storefront must mirror", () => {
  const product = buildProduct({
    buyerPrice: 10,
    maxRentalQuantity: 4,
    minimumRentalWeeks: 2,
    maximumRentalWeeks: 8,
  });

  assert.deepEqual(getProductRentalLimits(product, "week"), {
    maxQuantity: 4,
    minDuration: 2,
    maxDuration: 8,
    availableUnits: ["week"],
  });
});

test("rental limits still report quantity when the period unit is invalid", () => {
  const product = buildProduct({ buyerPrice: 10, maxRentalQuantity: 3 });
  const limits = getProductRentalLimits(product, "day");

  assert.equal(limits.maxQuantity, 3);
  assert.equal(limits.minDuration, null);
  assert.equal(limits.maxDuration, null);
});

test("rental limits list both period units when each has a price", () => {
  const product = buildProduct({ buyerPrice: 10, monthlyBuyerPrice: 30 });
  assert.deepEqual(getProductRentalLimits(product, "month").availableUnits, ["week", "month"]);
});

test("rental limits are null for an unknown product", () => {
  assert.equal(getProductRentalLimits(null, "week"), null);
});

test("the default maxRentalQuantity of 1 is reported, not silently widened", () => {
  const product = buildProduct({ buyerPrice: 10 });
  assert.equal(getProductRentalLimits(product, "week").maxQuantity, 1);
});
