"use strict";

// Short-term ("occasion") rentals: 1 to 7 days, with an explicit price for each
// offered length. Prices are stored, never derived by multiplying a daily rate,
// so 1 day = 50, 2 days = 80, 3 days = 105 is expressible as-is.

const MAX_OCCASION_DAYS = 7;

/**
 * @returns {{options: {days:number, price:number}[], errors: string[], warnings: string[]}}
 */
function normalizeOccasionOptions(raw) {
  const errors = [];
  const warnings = [];
  const byDays = new Map();

  if (!Array.isArray(raw) || raw.length === 0) {
    return { options: [], errors: ["At least one day-based price is required."], warnings };
  }

  raw.forEach((entry, index) => {
    const days = Number(entry?.days);
    const price = Number(entry?.price);
    if (!Number.isInteger(days) || days < 1 || days > MAX_OCCASION_DAYS) {
      errors.push(`Price option ${index + 1}: days must be a whole number from 1 to ${MAX_OCCASION_DAYS}.`);
      return;
    }
    if (!Number.isFinite(price) || price <= 0) {
      errors.push(`Price option for ${days} day(s): price must be greater than 0.`);
      return;
    }
    if (byDays.has(days)) {
      errors.push(`Day count ${days} is listed more than once.`);
      return;
    }
    byDays.set(days, Math.round(price * 100) / 100);
  });

  const options = [...byDays.entries()].sort((a, b) => a[0] - b[0]).map(([days, price]) => ({ days, price }));

  for (let i = 1; i < options.length; i += 1) {
    if (options[i].price < options[i - 1].price) {
      warnings.push(
        `${options[i].days} days (€${options[i].price}) costs less than ${options[i - 1].days} days (€${options[i - 1].price}). Check the prices.`
      );
    }
  }
  return { options, errors, warnings };
}

/** The stored price for exactly this many days, or null when it is not offered. */
function occasionPriceForDays(product, days) {
  const wanted = Number(days);
  const match = (product?.occasionPricing || []).find((option) => Number(option.days) === wanted);
  return match ? Number(match.price) : null;
}

/**
 * Re-prices occasion lines from the product's stored options, ignoring whatever
 * price the browser sent. Mutates the lines. Returns an error message when a
 * line asks for a day count the product does not offer, otherwise null.
 */
function applyOccasionPricing(items, productById) {
  for (const item of items) {
    const product = productById.get(String(item.productId || "").trim());
    if (product?.rentalMode !== "occasion") continue;
    const storedPrice = occasionPriceForDays(product, item.durationValue);
    if (item.durationUnit !== "day" || storedPrice === null) {
      return `${product.title || "This product"} is not offered for ${item.durationValue} ${item.durationUnit}(s).`;
    }
    item.unitPrice = storedPrice;
    item.baseUnitPrice = storedPrice;
    item.lineSubtotal = storedPrice * item.quantity;
    item.lineTotal = item.lineSubtotal + item.lineDeposit;
  }
  return null;
}

module.exports = { MAX_OCCASION_DAYS, normalizeOccasionOptions, occasionPriceForDays, applyOccasionPricing };
