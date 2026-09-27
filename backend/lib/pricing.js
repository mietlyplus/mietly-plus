"use strict";

// Authoritative server-side rental pricing.
//
// Everything chargeable is derived here from the persisted Product document.
// Amounts supplied by a client are never used. The weekly/monthly ladder below
// intentionally mirrors the storefront so displayed and charged prices agree:
//   offer price (when it genuinely undercuts the buyer price) -> buyer price -> monthlyPrice
// `monthlyPrice` is the shared legacy fallback for both period units.

const SUPPORTED_PERIOD_UNITS = ["week", "month"];

function toNonNegativeNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function toPositiveInteger(value, fallback) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}

// Currency amounts are held in euros and converted to cents for Stripe, so keep
// every intermediate value at two decimals to avoid float drift in the totals.
function roundCurrency(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
}

function normalizePeriodUnit(value) {
  const unit = String(value || "").trim().toLowerCase();
  return SUPPORTED_PERIOD_UNITS.includes(unit) ? unit : "";
}

function getPeriodPrices(product) {
  const weeklyBuyerPrice = toNonNegativeNumber(product.buyerPrice);
  const weeklyOfferPrice = toNonNegativeNumber(product.offerPrice);
  const monthlyBuyerPrice = toNonNegativeNumber(product.monthlyBuyerPrice);
  const monthlyOfferPrice = toNonNegativeNumber(product.monthlyOfferPrice);
  const legacyMonthlyPrice = toNonNegativeNumber(product.monthlyPrice);

  const weeklyHasOffer =
    weeklyBuyerPrice > 0 && weeklyOfferPrice > 0 && weeklyOfferPrice < weeklyBuyerPrice;
  const monthlyHasOffer =
    monthlyBuyerPrice > 0 && monthlyOfferPrice > 0 && monthlyOfferPrice < monthlyBuyerPrice;

  return {
    weeklyBuyerPrice,
    weeklyOfferPrice,
    monthlyBuyerPrice,
    monthlyOfferPrice,
    legacyMonthlyPrice,
    weeklyHasOffer,
    monthlyHasOffer,
  };
}

// Which period units the storefront is allowed to offer. When a product has no
// usable price on either ladder both are nominally "available" but resolve to 0,
// and pricing then rejects the line item rather than charging nothing.
function getAvailablePeriodUnits(product) {
  const prices = getPeriodPrices(product);
  const weeklyAvailable = prices.weeklyBuyerPrice > 0 || prices.weeklyOfferPrice > 0;
  const monthlyAvailable =
    prices.monthlyBuyerPrice > 0 || prices.monthlyOfferPrice > 0 || prices.legacyMonthlyPrice > 0;
  const neitherConfigured = !weeklyAvailable && !monthlyAvailable;

  return {
    week: weeklyAvailable || neitherConfigured,
    month: monthlyAvailable || neitherConfigured,
  };
}

function resolvePeriodUnitPrice(product, periodUnit) {
  const prices = getPeriodPrices(product);

  if (periodUnit === "month") {
    if (prices.monthlyHasOffer) return prices.monthlyOfferPrice;
    if (prices.monthlyBuyerPrice > 0) return prices.monthlyBuyerPrice;
    return prices.legacyMonthlyPrice;
  }

  if (prices.weeklyHasOffer) return prices.weeklyOfferPrice;
  if (prices.weeklyBuyerPrice > 0) return prices.weeklyBuyerPrice;
  return prices.legacyMonthlyPrice;
}

// The undiscounted reference price, used only for display/reporting on the order.
function resolvePeriodListPrice(product, periodUnit) {
  const prices = getPeriodPrices(product);
  if (periodUnit === "month") {
    return prices.monthlyBuyerPrice > 0 ? prices.monthlyBuyerPrice : prices.legacyMonthlyPrice;
  }
  return prices.weeklyBuyerPrice > 0 ? prices.weeklyBuyerPrice : prices.legacyMonthlyPrice;
}

function resolveDurationBounds(product, periodUnit) {
  if (periodUnit === "month") {
    const min = Math.max(1, toPositiveInteger(product.minimumRentalMonths, 1));
    const max = Math.max(min, toPositiveInteger(product.maximumRentalMonths, min));
    return { min, max };
  }

  const minWeeksFromDays = Math.max(1, Math.ceil(toPositiveInteger(product.minimumRentalDays, 7) / 7));
  const maxWeeksFromDays = Math.max(
    minWeeksFromDays,
    Math.ceil(toPositiveInteger(product.maximumRentalDays, 30) / 7)
  );
  const min = Math.max(1, toPositiveInteger(product.minimumRentalWeeks, minWeeksFromDays));
  const max = Math.max(min, toPositiveInteger(product.maximumRentalWeeks, maxWeeksFromDays));
  return { min, max };
}

function resolveMaxQuantity(product) {
  return Math.max(1, toPositiveInteger(product.maxRentalQuantity, 1));
}

// Requested counts must be exact integers. Truncating (e.g. 1.5 weeks -> 1)
// would silently charge for a period the customer did not choose.
function parseRequestedCount(value) {
  if (typeof value === "boolean") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return null;
  return parsed;
}

// The constraints the storefront needs in order to present the same limits the
// server enforces. Returned for valid and invalid lines alike so a client can
// clamp a stale cart back into range.
function getProductRentalLimits(product, periodUnit) {
  if (!product) return null;

  const unit = normalizePeriodUnit(periodUnit);
  const availability = getAvailablePeriodUnits(product);
  const availableUnits = SUPPORTED_PERIOD_UNITS.filter((candidate) => availability[candidate]);
  const bounds = unit ? resolveDurationBounds(product, unit) : null;

  return {
    maxQuantity: resolveMaxQuantity(product),
    minDuration: bounds ? bounds.min : null,
    maxDuration: bounds ? bounds.max : null,
    availableUnits,
  };
}

function failure(code, message) {
  return { ok: false, error: { code, message } };
}

/**
 * Price a single requested cart line against the persisted product.
 *
 * `request` carries only non-chargeable intent: periodUnit, durationValue,
 * quantity and startDate. Every euro amount on the returned line comes from
 * `product`.
 */
function priceOrderItem(product, request = {}) {
  if (!product) {
    return failure("PRODUCT_NOT_FOUND", "Product is no longer available.");
  }

  const productTitle = String(product.title || "this product");

  if (product.isActive === false) {
    return failure("PRODUCT_INACTIVE", `${productTitle} is no longer available for rent.`);
  }

  const periodUnit = normalizePeriodUnit(request.periodUnit);
  if (!periodUnit) {
    return failure(
      "INVALID_PERIOD_UNIT",
      `Rental period for ${productTitle} must be either "week" or "month".`
    );
  }

  const availability = getAvailablePeriodUnits(product);
  if (!availability[periodUnit]) {
    return failure(
      "PERIOD_UNIT_UNAVAILABLE",
      `${productTitle} cannot be rented by the ${periodUnit}.`
    );
  }

  const bounds = resolveDurationBounds(product, periodUnit);
  const durationValue = parseRequestedCount(request.durationValue);
  if (durationValue === null || durationValue < bounds.min || durationValue > bounds.max) {
    return failure(
      "INVALID_DURATION",
      `${productTitle} must be rented for between ${bounds.min} and ${bounds.max} ${periodUnit}s.`
    );
  }

  const maxQuantity = resolveMaxQuantity(product);
  const quantity = parseRequestedCount(request.quantity);
  if (quantity === null || quantity < 1 || quantity > maxQuantity) {
    return failure(
      "INVALID_QUANTITY",
      `${productTitle} allows a quantity between 1 and ${maxQuantity}.`
    );
  }

  const periodUnitPrice = roundCurrency(resolvePeriodUnitPrice(product, periodUnit));
  if (periodUnitPrice <= 0) {
    return failure("PRICE_UNAVAILABLE", `${productTitle} has no rental price configured.`);
  }

  const periodListPrice = roundCurrency(resolvePeriodListPrice(product, periodUnit));
  const unitPrice = roundCurrency(periodUnitPrice * durationValue);

  const depositEnabled = Boolean(product.depositEnabled);
  const securityDeposit = depositEnabled ? roundCurrency(toNonNegativeNumber(product.securityDeposit)) : 0;
  const deliveryFee = roundCurrency(toNonNegativeNumber(product.deliveryFee));

  const lineSubtotal = roundCurrency(unitPrice * quantity);
  const lineDeposit = roundCurrency(securityDeposit * quantity);
  const lineDelivery = roundCurrency(deliveryFee * quantity);
  const lineTotal = roundCurrency(lineSubtotal + lineDeposit + lineDelivery);

  return {
    ok: true,
    item: {
      quantity,
      durationValue,
      durationUnit: periodUnit,
      // Price for the whole rental period, per unit.
      unitPrice,
      // Per-period rate, kept for reporting and reminder emails.
      baseUnitPrice: periodUnitPrice,
      listUnitPrice: periodListPrice,
      depositEnabled,
      securityDeposit,
      deliveryFee,
      lineSubtotal,
      lineDeposit,
      lineDelivery,
      lineTotal,
      perUnitChargeable: roundCurrency(unitPrice + securityDeposit + deliveryFee),
      verificationRequired: product.verificationRequired !== false,
    },
  };
}

function sumOrderTotals(items) {
  const subtotal = roundCurrency(items.reduce((sum, item) => sum + item.lineSubtotal, 0));
  const depositTotal = roundCurrency(items.reduce((sum, item) => sum + item.lineDeposit, 0));
  const deliveryTotal = roundCurrency(items.reduce((sum, item) => sum + item.lineDelivery, 0));
  return {
    subtotal,
    depositTotal,
    deliveryTotal,
    total: roundCurrency(subtotal + depositTotal + deliveryTotal),
  };
}

module.exports = {
  SUPPORTED_PERIOD_UNITS,
  getAvailablePeriodUnits,
  getProductRentalLimits,
  normalizePeriodUnit,
  priceOrderItem,
  resolveDurationBounds,
  resolveMaxQuantity,
  resolvePeriodUnitPrice,
  roundCurrency,
  sumOrderTotals,
};
