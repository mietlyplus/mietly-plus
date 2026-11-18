"use strict";

// Delivery lead time: the earliest rental start is `deliveryLeadDays` after today.
// One field per product, shared by standard and occasion products.

const DEFAULT_LEAD_DAYS = 2;
const MAX_LEAD_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Returns an integer 0..30, or null when the value is not acceptable. */
function parseDeliveryLeadDays(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > MAX_LEAD_DAYS) return null;
  return number;
}

function leadDaysOf(product) {
  const parsed = parseDeliveryLeadDays(product?.deliveryLeadDays);
  return parsed === null ? DEFAULT_LEAD_DAYS : parsed;
}

/**
 * Checks each line's start date against its product's lead time. One day of
 * tolerance absorbs the difference between the customer's local date and UTC.
 * Lines without a start date or a known product are left to the existing checks.
 * @returns {string|null} an error message, or null
 */
function checkStartDates(items, productById, now = new Date()) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (const item of items) {
    const product = productById.get(String(item.productId || "").trim());
    if (!product || !item.startDate) continue;
    const start = Date.parse(`${String(item.startDate).slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(start)) return "A rental start date is not valid.";
    const earliest = today + (leadDaysOf(product) - 1) * DAY_MS;
    if (start < earliest) {
      return `${product.title || "This product"} needs ${leadDaysOf(product)} day(s) of delivery lead time. Choose a later start date.`;
    }
  }
  return null;
}

module.exports = { DEFAULT_LEAD_DAYS, MAX_LEAD_DAYS, parseDeliveryLeadDays, leadDaysOf, checkStartDates };
