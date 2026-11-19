"use strict";

// Billing plan for a priced cart.
//
// Standard rentals longer than one period are a FIXED-TERM subscription: the
// rental price is charged once per period for exactly `durationValue` periods.
// The delivery fee and the security deposit are one-time and are charged with
// the first payment only. A one-period rental and every occasion rental are a
// single one-time payment (their line is added to the first invoice).
//
// This module is pure: it decides the shape of the charge. Amounts come from
// lib/pricing.js (persisted product), never from the browser.

const { roundCurrency } = require("./pricing");

/**
 * @param {Array} items priced order items (output of priceOrderItem + snapshot)
 * @returns {{ok:true, mode:"one_time"|"recurring", interval:""|"week"|"month", cycles:number,
 *   recurringAmount:number, schedule:{payments:number, amount:number}[]} |
 *   {ok:false, code:string, message:string}}
 */
function planBilling(items) {
  const recurringItems = items.filter((item) => item.billingType === "recurring");
  if (recurringItems.length === 0) {
    return { ok: true, mode: "one_time", interval: "", cycles: 1, recurringAmount: 0, schedule: [] };
  }

  // One subscription has one billing interval.
  const intervals = new Set(recurringItems.map((item) => item.durationUnit));
  if (intervals.size > 1) {
    return {
      ok: false,
      code: "MIXED_BILLING_INTERVALS",
      message: "Weekly and monthly rentals have to be ordered separately. Please check out one billing period at a time.",
    };
  }

  const interval = [...intervals][0];
  const cycles = Math.max(...recurringItems.map((item) => item.durationValue));
  const schedule = buildPaymentSchedule(recurringItems);
  return {
    ok: true,
    mode: "recurring",
    interval,
    cycles,
    recurringAmount: schedule.length ? schedule[0].amount : 0,
    schedule,
  };
}

/**
 * Payments after the first, as consecutive runs of an equal amount. Items of
 * different lengths drop out of the schedule as they end.
 * Example: A 3 weeks x 20, B 2 weeks x 10 -> payments 1-2 cost 30, payment 3 costs 20.
 * The first payment is the first entry's first charge, so `payments` counts it.
 */
function buildPaymentSchedule(recurringItems) {
  const maxCycles = Math.max(0, ...recurringItems.map((item) => item.durationValue));
  const runs = [];
  for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
    const amount = roundCurrency(
      recurringItems
        .filter((item) => item.durationValue >= cycle)
        .reduce((sum, item) => sum + item.recurringPerUnit * item.quantity, 0)
    );
    const last = runs[runs.length - 1];
    if (last && last.amount === amount) last.payments += 1;
    else runs.push({ payments: 1, amount });
  }
  return runs;
}

/**
 * Subscription-schedule phases for a Stripe subscription created by Checkout.
 *
 * @param {{cycles:number, quantity:number, priceId:string}[]} lines recurring lines
 * @returns {{iterations:number, items:{price:string, quantity:number}[]}[]}
 */
function buildSchedulePhases(lines) {
  const lengths = [...new Set(lines.map((line) => line.cycles))].sort((a, b) => a - b);
  const phases = [];
  let previous = 0;
  for (const length of lengths) {
    phases.push({
      iterations: length - previous,
      items: lines
        .filter((line) => line.cycles >= length)
        .map((line) => ({ price: line.priceId, quantity: line.quantity })),
    });
    previous = length;
  }
  return phases;
}

module.exports = { planBilling, buildPaymentSchedule, buildSchedulePhases };
