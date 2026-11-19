"use strict";

// Delivery lead time: the earliest rental start is `deliveryLeadDays` calendar
// days after today, counted on the German calendar (Europe/Berlin):
//   0 = today, 1 = tomorrow, 2 = the day after tomorrow, ...
// The storefront uses the identical rule (frontend/lib/delivery-date.ts), so the
// date picker and this check can never disagree.

const DEFAULT_LEAD_DAYS = 2;
const MAX_LEAD_DAYS = 30;
const TIME_ZONE = "Europe/Berlin";

const berlinDateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today's calendar date in Germany as YYYY-MM-DD. */
function berlinToday(now = new Date()) {
  return berlinDateFormat.format(now);
}

/** Adds calendar days to a YYYY-MM-DD string. Pure date arithmetic: no DST effects. */
function addDaysToDateString(dateString, days) {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function earliestStartDate(leadDays, now = new Date()) {
  return addDaysToDateString(berlinToday(now), leadDays);
}

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
 * Checks one start date against a product's lead time, exactly.
 * @returns {string|null} an error message, or null
 */
function checkStartDate(product, startDate, now = new Date()) {
  const start = String(startDate || "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || Number.isNaN(Date.parse(`${start}T00:00:00Z`))) {
    return "A rental start date is not valid.";
  }
  const leadDays = leadDaysOf(product);
  const earliest = earliestStartDate(leadDays, now);
  if (start < earliest) {
    return `${product?.title || "This product"} needs ${leadDays} day(s) of delivery lead time. The earliest start date is ${earliest}.`;
  }
  return null;
}

/** Same check over cart lines; lines without a date or a known product are skipped. */
function checkStartDates(items, productById, now = new Date()) {
  for (const item of items) {
    const product = productById.get(String(item.productId || "").trim());
    if (!product || !item.startDate) continue;
    const message = checkStartDate(product, item.startDate, now);
    if (message) return message;
  }
  return null;
}

module.exports = {
  DEFAULT_LEAD_DAYS, MAX_LEAD_DAYS, TIME_ZONE,
  berlinToday, addDaysToDateString, earliestStartDate, parseDeliveryLeadDays, leadDaysOf, checkStartDate, checkStartDates,
};
