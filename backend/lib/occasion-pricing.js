"use strict";

// Short-term ("occasion") rentals: 1 to 7 days at a single DAILY rate.
// The customer pays daily rate x days, once, at checkout. There is no recurring
// billing for an occasion product.

const MAX_OCCASION_DAYS = 7;

/**
 * Validates a daily rate.
 * @returns {{rate:number, errors:string[]}}
 */
function normalizeDailyRate(raw) {
  const rate = Number(raw);
  if (raw === undefined || raw === null || raw === "" || !Number.isFinite(rate) || rate <= 0) {
    return { rate: 0, errors: ["A daily rental price greater than 0 is required."] };
  }
  if (rate > 100000) return { rate: 0, errors: ["The daily rental price is unrealistically high."] };
  return { rate: Math.round(rate * 100) / 100, errors: [] };
}

/**
 * Occasion data created before the daily-rate model listed explicit prices per
 * day count. Converts such a list into a daily rate: the 1-day price, otherwise
 * the first option's price divided by its days.
 * @returns {{rate:number, errors:string[], warnings:string[]}}
 */
function dailyRateFromLegacyOptions(raw) {
  const options = (Array.isArray(raw) ? raw : [])
    .map((entry) => ({ days: Number(entry?.days), price: Number(entry?.price) }))
    .filter((entry) => Number.isInteger(entry.days) && entry.days >= 1 && entry.days <= MAX_OCCASION_DAYS && entry.price > 0)
    .sort((a, b) => a.days - b.days);
  if (options.length === 0) return { rate: 0, errors: ["A daily rental price greater than 0 is required."], warnings: [] };

  const oneDay = options.find((entry) => entry.days === 1);
  const rate = Math.round((oneDay ? oneDay.price : options[0].price / options[0].days) * 100) / 100;
  const warnings = [`Per-length occasion prices are no longer used; the daily rate was set to €${rate}. Occasion rentals now cost daily rate x days.`];
  return { rate, errors: [], warnings };
}

/** Total for an occasion rental of `days` days at `dailyRate`. */
function occasionTotal(dailyRate, days) {
  return Math.round(Number(dailyRate) * Number(days) * 100) / 100;
}

module.exports = { MAX_OCCASION_DAYS, normalizeDailyRate, dailyRateFromLegacyOptions, occasionTotal };
